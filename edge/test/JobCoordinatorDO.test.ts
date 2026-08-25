import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch, onCleanup, onJobTimeout, type JobCoordinatorDeps } from "../src/JobCoordinatorDO";
import type { JobState } from "../src/types";

// `@cloudflare/vitest-plugin` (1.0.0) cannot construct a `Container` subclass in this test
// pool -- its constructor requires a real `ctx.container`, which the pool never provisions
// (the plugin's own container-resolution code exists but is never called). So these tests
// exercise the exact same functions `JobCoordinatorDO` delegates to, against fake/spied
// deps, rather than a real DO instance. See the doc comment on `JobCoordinatorDeps`.

const STATE_KEY = "state";

function createFakeStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
    async deleteAll(): Promise<void> {
      map.clear();
    },
  };
}

function createDeps(containerFetch: JobCoordinatorDeps["containerFetch"] = vi.fn()) {
  const storage = createFakeStorage();
  let background: Promise<unknown> = Promise.resolve();
  const deps: JobCoordinatorDeps = {
    env,
    storage,
    waitUntil: (promise) => {
      background = promise;
    },
    containerFetch,
    schedule: vi.fn(async () => undefined),
    deleteSchedules: vi.fn(),
    acceptWebSocket: vi.fn(),
    getWebSockets: () => [],
  };
  return { deps, storage, waitForBackground: () => background };
}

function dispatchRequest(body: unknown): Request {
  return new Request("http://do/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stateRequest = () => new Request("http://do/state");
const wsRequest = () => new Request("http://do/ws");

function completedResponse(jobId: string): Response {
  return Response.json({
    jobId,
    status: "completed",
    executionTimeMs: 42,
    taxsea: { packageVersion: "1.4.0" },
    results: {},
  });
}

function failedResponse(jobId: string, error: string): Response {
  // HTTP 200 with status: "failed" -- a job-level failure, not an infra failure (docs/api.md #2).
  return Response.json({ jobId, status: "failed", executionTimeMs: 7, error });
}

async function readState(storage: ReturnType<typeof createFakeStorage>): Promise<JobState | undefined> {
  return storage.get<JobState>(STATE_KEY);
}

describe("JobCoordinatorDO logic", () => {
  let outputKeysWritten: string[];

  beforeEach(() => {
    outputKeysWritten = [];
  });

  it("happy path: writes output.json to R2 before flipping state to completed", async () => {
    const jobId = crypto.randomUUID();
    const outputKey = `jobs/${jobId}/output.json`;
    const containerFetch = vi.fn().mockResolvedValue(completedResponse(jobId));
    const { deps, storage, waitForBackground } = createDeps(containerFetch);

    let stateWhenOutputWritten: JobState["status"] | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalPut = env.TAXSEA_BUCKET.put.bind(env.TAXSEA_BUCKET) as (...args: any[]) => Promise<unknown>;
    vi.spyOn(env.TAXSEA_BUCKET, "put").mockImplementation((async (key: string, ...rest: unknown[]) => {
      if (key === outputKey) {
        outputKeysWritten.push(key);
        stateWhenOutputWritten = (await readState(storage))?.status;
      }
      return originalPut(key, ...rest);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const dispatchResponse = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);
    await waitForBackground();

    const finalState = await readState(storage);
    expect(finalState?.status).toBe("completed");
    expect(finalState?.executionTimeMs).toBe(42);
    expect(finalState?.finishedAt).toBeDefined();
    // The R2 write for output.json happened while state was still "running", i.e. strictly
    // before the state flipped to "completed" (docs/api.md #3, PLAN.md #2.6).
    expect(outputKeysWritten).toEqual([outputKey]);
    expect(stateWhenOutputWritten).toBe("running");

    expect(containerFetch).toHaveBeenCalledWith(
      "http://localhost/run",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer ") }),
      }),
    );
    const [, init] = containerFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ jobId, mode: "ora", taxa: ["Foo"] });

    const stored = await env.TAXSEA_BUCKET.get(outputKey);
    expect(stored).not.toBeNull();
    expect(await stored?.json()).toMatchObject({ jobId, status: "completed" });

    vi.restoreAllMocks();
  });

  it("returns 409 on duplicate dispatch", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockResolvedValue(completedResponse(jobId));
    const { deps } = createDeps(containerFetch);

    const first = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(first.status).toBe(201);

    const second = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(second.status).toBe(409);
  });

  it("rejects a dispatch whose jobId is not a UUIDv4 before touching R2 or the container", async () => {
    const containerFetch = vi.fn();
    const { deps } = createDeps(containerFetch);

    const response = await handleFetch(deps, dispatchRequest({ jobId: "../../evil", mode: "ora", taxa: ["Foo"] }));
    expect(response.status).toBe(400);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("job-level failure: container returns HTTP 200 with status: failed", async () => {
    const jobId = crypto.randomUUID();
    const rawError = "Error in fn(x) : object not found\n  at /usr/lib/R/library/taxsea/worker.R:42";
    const containerFetch = vi.fn().mockResolvedValue(failedResponse(jobId, rawError));
    const { deps, storage, waitForBackground } = createDeps(containerFetch);

    const dispatchResponse = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);
    await waitForBackground();

    const finalState = await readState(storage);
    expect(finalState?.status).toBe("failed");
    // Sanitized: no raw filesystem path reaches the client (docs/api.md #6).
    expect(finalState?.error).not.toContain("/usr/lib/R");
    expect(finalState?.error).toContain("object not found");
  });

  it("infrastructure failure: containerFetch throws", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:8080"));
    const { deps, storage, waitForBackground } = createDeps(containerFetch);

    const dispatchResponse = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);
    await waitForBackground();

    const finalState = await readState(storage);
    expect(finalState?.status).toBe("failed");
    // The raw error is logged internally, not relayed to the client.
    expect(finalState?.error).not.toContain("ECONNREFUSED");
    expect(finalState?.error).not.toContain("10.0.0.1");
  });

  it("infrastructure failure: containerFetch resolves non-2xx", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockResolvedValue(new Response("bad auth", { status: 401 }));
    const { deps, storage, waitForBackground } = createDeps(containerFetch);

    const dispatchResponse = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);
    await waitForBackground();

    const finalState = await readState(storage);
    expect(finalState?.status).toBe("failed");
    expect(finalState?.error).not.toContain("bad auth");
  });

  it("onJobTimeout while running sets timed_out with a user-facing timeout message", async () => {
    const jobId = crypto.randomUUID();
    // Never resolves -- the job is still "running" when the timeout fires.
    const containerFetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { deps, storage } = createDeps(containerFetch);

    const dispatchResponse = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);

    await onJobTimeout(deps);

    const state = await readState(storage);
    expect(state?.status).toBe("timed_out");
    const timeoutSeconds = Math.round(env.JOB_TIMEOUT_MS / 1000);
    expect(state?.error).toContain(`${timeoutSeconds}s`);
    expect(state?.finishedAt).toBeDefined();
  });

  it("onJobTimeout is a no-op once the job already reached a terminal state", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockResolvedValue(completedResponse(jobId));
    const { deps, storage, waitForBackground } = createDeps(containerFetch);

    await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    await waitForBackground();
    const completed = await readState(storage);
    expect(completed?.status).toBe("completed");

    // A stray/late timeout firing after completion must not clobber the result.
    await onJobTimeout(deps);
    const state = await readState(storage);
    expect(state?.status).toBe("completed");
  });

  it("onCleanup wipes DO storage", async () => {
    const { deps, storage } = createDeps();
    await storage.put(STATE_KEY, { jobId: "x", status: "completed" });

    await onCleanup(deps);

    expect(await readState(storage)).toBeUndefined();
  });

  it("GET /state never calls containerFetch and 404s (not a synthetic object) when never dispatched", async () => {
    const containerFetch = vi.fn();
    const { deps } = createDeps(containerFetch);

    const response = await handleFetch(deps, stateRequest());
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).not.toHaveProperty("status");
    expect(body).toMatchObject({ error: "not_found" });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("GET /state returns the stored JobState once dispatched, without calling containerFetch again", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockResolvedValue(completedResponse(jobId));
    const { deps } = createDeps(containerFetch);

    await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    const callsAfterDispatch = containerFetch.mock.calls.length;

    const response = await handleFetch(deps, stateRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as JobState;
    expect(body.jobId).toBe(jobId);

    expect(containerFetch.mock.calls.length).toBe(callsAfterDispatch);
  });

  it("GET /ws routes without calling containerFetch", async () => {
    const containerFetch = vi.fn();
    const { deps } = createDeps(containerFetch);

    await handleFetch(deps, wsRequest());
    expect(containerFetch).not.toHaveBeenCalled();
  });
});
