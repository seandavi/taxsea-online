import { Container, type StopParams } from "@cloudflare/containers";
import { log } from "./log";
import type { ContainerRunResponse, JobPayload, JobState } from "./types";

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATE_KEY = "state";
const CLEANUP_DELAY_SECONDS = 24 * 60 * 60;
const MAX_ERROR_LENGTH = 2000; // docs/api.md #6

const inputKey = (jobId: string) => `jobs/${jobId}/input.json`;
const outputKey = (jobId: string) => `jobs/${jobId}/output.json`;

function jsonError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

/** Strips absolute filesystem paths and the shared secret, and truncates, so an R error that
 * echoes submitted input content, a container path, or the environment never reaches the
 * client raw (docs/api.md #6).
 *
 * The secret redaction duplicates `worker/main.py`'s `_sanitize_error` on purpose (issue #70).
 * The container-side pass always runs first today, so this is currently redundant -- but that
 * is a call-ordering coincidence, not a guarantee. Any future path that reaches here without
 * having gone through main.py (a different container entrypoint, an error raised by the DO
 * itself while handling a container response) would otherwise have no redaction at all. Two
 * independent passes cost one string replace; relying on ordering costs a leaked secret. */
function sanitizeError(message: string, secret?: string): string {
  const withoutPaths = message.replace(/\/(?:[^\s"'()]+\/)*[^\s"'()]+/g, "[path]");
  // Guard against a short/empty secret turning this into a replace-everything.
  const redacted =
    secret && secret.length >= 8 ? withoutPaths.split(secret).join("[redacted]") : withoutPaths;
  return redacted.slice(0, MAX_ERROR_LENGTH);
}

type ScheduleName = "onJobTimeout" | "onCleanup";

/**
 * The storage/container/scheduling surface the coordination logic below needs, narrowed to
 * exactly what it uses.
 *
 * This is injected rather than read off `this` directly for one concrete reason:
 * `@cloudflare/vitest-plugin` (as of 1.0.0) cannot construct a `Container` subclass at all --
 * its constructor throws `"Containers have not been enabled for this Durable Object class"`
 * unless `ctx.container` is already populated, and the test pool never provisions that (the
 * container-resolution code for it exists in the plugin's bundle but is dead -- never
 * called). So every acceptance-criteria test below runs the exact same functions this class
 * uses, against fakes/spies, since a real `JobCoordinatorDO` instance is not obtainable in
 * this test environment regardless of mocking `containerFetch`. `JobCoordinatorDO` itself
 * stays a thin, effectively-untestable wrapper for exactly the same reason.
 */
export interface JobCoordinatorDeps {
  env: Env;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    deleteAll(): Promise<void>;
  };
  waitUntil: (promise: Promise<unknown>) => void;
  containerFetch: (url: string, init: RequestInit) => Promise<Response>;
  schedule: (delaySeconds: number, callback: ScheduleName) => Promise<unknown>;
  deleteSchedules: (callback: ScheduleName) => void;
  /** Cloudflare's Hibernation API: registers `server` with the runtime so it survives this
   * DO instance being evicted from memory (maps to `this.ctx.acceptWebSocket`). */
  acceptWebSocket: (server: WebSocket) => void;
  /** The live sockets, owned by the runtime rather than this DO instance -- still returns
   * sockets accepted before an eviction/revival cycle (maps to `this.ctx.getWebSockets()`). */
  getWebSockets: () => WebSocket[];
}

const isTerminal = (status: JobState["status"]) =>
  status === "completed" || status === "failed" || status === "timed_out";

/** Routes `/dispatch`, `/state` and `/ws`. Only `/dispatch` ever calls containerFetch -- a
 * status poll or WS upgrade must never boot a multi-GB container. */
export async function handleFetch(deps: JobCoordinatorDeps, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  switch (pathname) {
    case "/dispatch":
      return request.method === "POST"
        ? handleDispatch(deps, request)
        : new Response("Method Not Allowed", { status: 405 });
    case "/state":
      return request.method === "GET"
        ? handleState(deps)
        : new Response("Method Not Allowed", { status: 405 });
    case "/ws":
      return handleWebSocketUpgrade(deps, request);
    default:
      return new Response("Not Found", { status: 404 });
  }
}

/** Upgrades to the Hibernation-API WebSocket channel (docs/api.md `GET /ws`). Never calls
 * containerFetch -- opening a progress socket must not boot a container. */
async function handleWebSocketUpgrade(deps: JobCoordinatorDeps, request: Request): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  // WebSocket upgrades are not subject to CORS, so this Origin check is the only thing
  // stopping any website from opening a socket against a known jobId (docs/api.md #6).
  const workerOrigin = new URL(request.url).origin;
  if (request.headers.get("Origin") !== workerOrigin) {
    return jsonError(403, "forbidden", "Origin not allowed");
  }

  const state = await deps.storage.get<JobState>(STATE_KEY);
  if (!state) {
    return jsonError(404, "not_found", "No job found for this id");
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  // acceptWebSocket, not server.accept() -- the Hibernation API variant, so this socket is
  // owned by the runtime and survives this DO instance being evicted (PLAN.md #1.3).
  deps.acceptWebSocket(server);

  // Sent immediately so a client connecting after the job already finished sees the
  // terminal state right away instead of hanging for a broadcast that already happened.
  server.send(JSON.stringify(state));
  if (isTerminal(state.status)) {
    server.close(1000);
  }

  return new Response(null, { status: 101, webSocket: client });
}

/** Pushes `state` to every connected socket. `getWebSockets()` is runtime-owned (Hibernation
 * API), so this reaches clients connected before an eviction/revival cycle just as well as
 * ones connected after -- fixing the old in-memory `Set<WebSocket>` bug (PLAN.md #1.3). */
function broadcast(deps: JobCoordinatorDeps, state: JobState): void {
  const payload = JSON.stringify(state);
  for (const ws of deps.getWebSockets()) {
    try {
      ws.send(payload);
      if (isTerminal(state.status)) {
        ws.close(1000);
      }
    } catch (err) {
      log("job-coordinator", "error", "failed to broadcast job state to a WebSocket, closing it", {
        jobId: state.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        ws.close();
      } catch {
        // Already closed/closing -- nothing left to do.
      }
    }
  }
}

/** Hibernation handlers. The channel is server-push only (docs/api.md `GET /ws`) -- there is
 * no client command protocol. The only inbound message handled is a bare "ping" keepalive. */
export function handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
  if (message === "ping") {
    ws.send("pong");
  }
}

export function handleWebSocketClose(ws: WebSocket, code: number, reason: string): void {
  ws.close(code, reason);
}

export function handleWebSocketError(_ws: WebSocket, error: unknown): void {
  log("job-coordinator", "error", "WebSocket error", {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function handleDispatch(deps: JobCoordinatorDeps, request: Request): Promise<Response> {
  let body: JobPayload;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Body must be valid JSON");
  }

  const { jobId, ...payload } = body;
  // Defense in depth: the router mints jobId with crypto.randomUUID() and this DO is
  // addressed by it, but the value still arrives as untrusted request-body data and is about
  // to be interpolated into an R2 key, so it is re-validated here (docs/api.md #4).
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    return jsonError(400, "invalid_request", "jobId must be a valid UUIDv4");
  }

  if (await deps.storage.get<JobState>(STATE_KEY)) {
    return jsonError(409, "already_dispatched", "This job has already been dispatched");
  }

  const now = Date.now();
  await deps.env.TAXSEA_BUCKET.put(inputKey(jobId), JSON.stringify({ jobId, ...payload }), {
    httpMetadata: { contentType: "application/json" },
  });

  const state: JobState = { jobId, status: "running", createdAt: now, startedAt: now };
  await deps.storage.put(STATE_KEY, state);
  await deps.schedule(deps.env.JOB_TIMEOUT_MS / 1000, "onJobTimeout");
  log("job-coordinator", "info", "job submitted", { jobId, elapsedMs: Date.now() - now });

  // Runs after the response below is returned; waitUntil keeps the DO alive for it even if
  // the client disconnects immediately (PLAN.md #1.3, "fire-and-forget dispatch can
  // vanish"). The timeout schedule armed above is the backstop if the DO is evicted anyway.
  deps.waitUntil(runJob(deps, jobId, payload, now));

  return Response.json(state, { status: 201 });
}

export async function runJob(
  deps: JobCoordinatorDeps,
  jobId: string,
  payload: JobPayload,
  createdAt: number,
): Promise<void> {
  log("job-coordinator", "info", "container call started", { jobId, elapsedMs: Date.now() - createdAt });

  let response: Response;
  try {
    // containerFetch, not this.fetch -- this.fetch is overridden above and would recurse.
    response = await deps.containerFetch("http://localhost/run", {
      method: "POST",
      // Content-Type is required, not cosmetic: without it, FastAPI/Starlette can't parse
      // the body as JSON for the RunRequest pydantic model and rejects every request with
      // 400 -- found via the real deployed smoke test (issue #23), reproduced locally by
      // POSTing the identical body with and without this header against the built image.
      headers: {
        Authorization: `Bearer ${deps.env.WORKER_SHARED_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jobId, ...payload }),
    });
  } catch (err) {
    log("job-coordinator", "error", "container call failed: containerFetch threw -- infrastructure failure", {
      jobId,
      elapsedMs: Date.now() - createdAt,
      error: err instanceof Error ? err.message : String(err),
    });
    await finalizeState(deps, { status: "failed", error: "The compute container could not be reached." });
    return;
  }

  log("job-coordinator", "info", "container call returned", {
    jobId,
    elapsedMs: Date.now() - createdAt,
    status: response.status,
  });

  if (!response.ok) {
    // Not logging response body content -- it's arbitrary container-generated text.
    log("job-coordinator", "error", "container call returned non-2xx -- infrastructure failure", {
      jobId,
      elapsedMs: Date.now() - createdAt,
      status: response.status,
    });
    await finalizeState(deps, { status: "failed", error: "The compute container returned an unexpected error." });
    return;
  }

  let result: ContainerRunResponse;
  try {
    result = await response.json();
  } catch (err) {
    log("job-coordinator", "error", "container response was not valid JSON -- infrastructure failure", {
      jobId,
      elapsedMs: Date.now() - createdAt,
      error: err instanceof Error ? err.message : String(err),
    });
    await finalizeState(deps, { status: "failed", error: "The compute container returned an unexpected response." });
    return;
  }

  if (result.status === "completed") {
    // Write output.json before flipping state, so a client observing "completed" can always
    // fetch a result immediately after (docs/api.md #3, PLAN.md #2.6).
    await deps.env.TAXSEA_BUCKET.put(outputKey(jobId), JSON.stringify(result), {
      httpMetadata: { contentType: "application/json" },
    });
    await finalizeState(deps, { status: "completed", executionTimeMs: result.executionTimeMs });
    return;
  }

  if (result.status === "failed") {
    // HTTP 200 + status: "failed" is a job-level failure (the analysis ran and failed),
    // distinct from the infrastructure failures logged above (docs/api.md #2). Not logging
    // result.error itself -- an R error can echo submitted input content (docs/api.md #6).
    log("job-coordinator", "error", "job failed inside the container", {
      jobId,
      elapsedMs: Date.now() - createdAt,
      executionTimeMs: result.executionTimeMs,
      errorLength: result.error.length,
    });
    await finalizeState(deps, {
      status: "failed",
      error: sanitizeError(result.error, deps.env.WORKER_SHARED_SECRET),
      executionTimeMs: result.executionTimeMs,
    });
    return;
  }

  log("job-coordinator", "error", "container returned an unrecognized response shape", {
    jobId,
    elapsedMs: Date.now() - createdAt,
  });
  await finalizeState(deps, { status: "failed", error: "The compute container returned an unexpected response." });
}

async function finalizeState(
  deps: JobCoordinatorDeps,
  patch: { status: "completed" | "failed"; error?: string; executionTimeMs?: number },
): Promise<void> {
  const state = await deps.storage.get<JobState>(STATE_KEY);
  if (!state || state.status !== "running") {
    // Already finalized by a race with the timeout alarm -- nothing to do.
    return;
  }
  const finishedAt = Date.now();
  const finalState: JobState = {
    ...state,
    status: patch.status,
    finishedAt,
    executionTimeMs: patch.executionTimeMs ?? finishedAt - (state.startedAt ?? state.createdAt),
    error: patch.error,
  };
  await deps.storage.put(STATE_KEY, finalState);
  deps.deleteSchedules("onJobTimeout");
  await deps.schedule(CLEANUP_DELAY_SECONDS, "onCleanup");
  log("job-coordinator", "info", "terminal state", {
    jobId: finalState.jobId,
    status: finalState.status,
    elapsedMs: finishedAt - state.createdAt,
  });
  broadcast(deps, finalState);
}

async function handleState(deps: JobCoordinatorDeps): Promise<Response> {
  const state = await deps.storage.get<JobState>(STATE_KEY);
  if (!state) {
    return jsonError(404, "not_found", "No job found for this id");
  }
  return Response.json(state);
}

/**
 * Fires JOB_TIMEOUT_MS after dispatch (scheduled in handleDispatch via `deps.schedule`).
 *
 * Named callback rather than an `alarm()` override on purpose: `Container`'s own `alarm()`
 * is "in charge of renewing the container activity and keeping the durable object alive"
 * (see @cloudflare/containers' README, "Instead of using the default alarm handler, use
 * schedule() instead"). Overriding `alarm()` here would silently break that -- sleepAfter
 * and the container's activity timeout run through the same single DO alarm.
 */
export async function onJobTimeout(deps: JobCoordinatorDeps): Promise<void> {
  const state = await deps.storage.get<JobState>(STATE_KEY);
  log(
    "job-coordinator",
    "info",
    "alarm fired",
    state ? { jobId: state.jobId, elapsedMs: Date.now() - state.createdAt } : {},
  );
  if (!state || state.status !== "running") return; // already finalized

  const timeoutSeconds = Math.round(deps.env.JOB_TIMEOUT_MS / 1000);
  const finishedAt = Date.now();
  const finalState: JobState = {
    ...state,
    status: "timed_out",
    finishedAt,
    executionTimeMs: finishedAt - (state.startedAt ?? state.createdAt),
    error: `Job timed out after ${timeoutSeconds}s`,
  };
  await deps.storage.put(STATE_KEY, finalState);
  // ponytail: if the DO was evicted mid-job, the container's in-flight result is simply
  // lost -- it has nowhere to persist it (no storage access, PLAN.md #2.6) and the client
  // just resubmits. Recovery-by-scanning-R2 is a deliberate v1 ceiling, not an oversight
  // (PLAN.md #2.6); add it if lost in-flight jobs become a real support burden.
  await deps.schedule(CLEANUP_DELAY_SECONDS, "onCleanup");
  log("job-coordinator", "info", "terminal state", {
    jobId: finalState.jobId,
    status: finalState.status,
    elapsedMs: finishedAt - state.createdAt,
  });
  broadcast(deps, finalState);
}

/** Scheduled 24h after a job reaches a terminal state, so a finished job's DO storage
 * doesn't grow unbounded. `jobs/{jobId}/{input,output}.json` in R2 are cleaned up separately
 * by the bucket's own lifecycle rules (issue #19), not by the DO. */
export async function onCleanup(deps: JobCoordinatorDeps): Promise<void> {
  await deps.storage.deleteAll();
}

/**
 * One Durable Object per job. `Container` (from `@cloudflare/containers`) extends
 * `DurableObject`, so this class is simultaneously the job coordinator and the
 * container-backed class bound in wrangler.toml's `[[containers]]` and
 * `[[durable_objects.bindings]]` blocks (see /edge/wrangler.toml, issue #8).
 *
 * The DO owns all R2 I/O; the container never touches storage or the network
 * (PLAN.md #2.6) -- payloads cross the DO<->container boundary by value, through the
 * containerFetch request/response bodies only.
 *
 * This class is intentionally thin: every acceptance-criteria behavior lives in the plain
 * functions above (`handleFetch`, `runJob`, `onJobTimeout`, `onCleanup`), which take an
 * explicit `JobCoordinatorDeps`. See that interface's doc comment for why.
 */
export class JobCoordinatorDO extends Container<Env> {
  defaultPort = 8080;
  // Each DO serves exactly one job; there is nothing left to keep warm once it finishes.
  // "1m" contradicted that comment and was the dominant term in how long a container slot
  // stayed occupied -- boot + runtime is ~15-50s, so a full idle minute on top roughly
  // doubled it and was the main driver of the capacity exhaustion in issue #69. 5s only
  // covers the teardown window.
  sleepAfter = "5s";
  pingEndpoint = "/health";
  // The container executes user-supplied input through R with zero network egress -- a
  // deliberate security property, not an oversight. Do not flip this on to add a storage
  // client; the DO does all R2 I/O (PLAN.md #2.6).
  enableInternet = false;
  envVars = {
    WORKER_SHARED_SECRET: this.env.WORKER_SHARED_SECRET,
    RSCRIPT_TIMEOUT_SECONDS: String(Math.round(this.env.JOB_TIMEOUT_MS / 1000)),
  };

  private deps(): JobCoordinatorDeps {
    return {
      env: this.env,
      storage: this.ctx.storage,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      containerFetch: (url, init) => this.containerFetch(url, init),
      schedule: (delaySeconds, callback) => this.schedule(delaySeconds, callback),
      deleteSchedules: (callback) => this.deleteSchedules(callback),
      acceptWebSocket: (server) => this.ctx.acceptWebSocket(server),
      getWebSockets: () => this.ctx.getWebSockets(),
    };
  }

  fetch(request: Request): Promise<Response> {
    return handleFetch(this.deps(), request);
  }

  async onJobTimeout(): Promise<void> {
    await onJobTimeout(this.deps());
  }

  async onCleanup(): Promise<void> {
    await onCleanup(this.deps());
  }

  /** Container boot time dominates job latency, so this is the most useful timing number
   * in the whole system: elapsed time from job creation to the container reporting ready. */
  async onStart(): Promise<void> {
    const state = await this.ctx.storage.get<JobState>(STATE_KEY);
    log(
      "container",
      "info",
      "container started",
      state ? { jobId: state.jobId, elapsedMs: Date.now() - state.createdAt } : {},
    );
  }

  async onStop(params: StopParams): Promise<void> {
    const state = await this.ctx.storage.get<JobState>(STATE_KEY);
    log("container", "info", "container stopped", {
      ...(state ? { jobId: state.jobId, elapsedMs: Date.now() - state.createdAt } : {}),
      exitCode: params.exitCode,
      reason: params.reason,
    });
  }

  onError(error: unknown): unknown {
    log("container", "error", "container error", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // preserve the base class's default behavior of rethrowing
  }

  // Hibernation API handlers -- see `handleWebSocketMessage` et al above. Server-push only,
  // so the only inbound message handled is a "ping" keepalive (docs/api.md `GET /ws`).
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    handleWebSocketMessage(ws, message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    handleWebSocketClose(ws, code, reason);
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    handleWebSocketError(ws, error);
  }
}
