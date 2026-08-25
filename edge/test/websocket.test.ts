import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleFetch, type JobCoordinatorDeps } from "../src/JobCoordinatorDO";
import type { JobState } from "../src/types";

// Unlike JobCoordinatorDO.test.ts, none of this needs a real `JobCoordinatorDO` instance --
// `new WebSocketPair()`, `Response`, and `Request` are real workerd primitives available in
// this test pool regardless of the `Container`-construction limitation documented on
// `JobCoordinatorDeps`. What *is* faked is the Hibernation API surface itself
// (`ctx.acceptWebSocket`/`ctx.getWebSockets`), since there's no real `ctx` here either --
// a small shared "registry" array stands in for it, exactly like `createFakeStorage()`
// stands in for `ctx.storage` below.

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

/** Stands in for `ctx.getWebSockets()`/`ctx.acceptWebSocket()`: in production these are
 * owned by the runtime, not by any particular DO instance, which is exactly what makes
 * hibernation survive eviction. Sharing one registry across two otherwise-independent
 * `deps` objects (see the eviction test below) is how that platform-owned persistence is
 * modeled here. */
function createFakeWebSocketRegistry() {
  const sockets: WebSocket[] = [];
  return {
    // ponytail: there's no real `ctx` in this test pool, so the fake "accept" activates the
    // real WebSocketPair socket via the ordinary (non-hibernatable) `.accept()` -- otherwise
    // `send()` throws "you must call accept() or state.acceptWebSocket() first". Production
    // code always goes through the real `ctx.acceptWebSocket()` instead (see
    // `JobCoordinatorDO.deps()`); this substitution only exists to make the socket usable
    // inside this fake registry.
    accept: (ws: WebSocket) => {
      ws.accept();
      sockets.push(ws);
    },
    getAll: () => sockets,
  };
}

function createDeps(opts: {
  storage?: ReturnType<typeof createFakeStorage>;
  registry?: ReturnType<typeof createFakeWebSocketRegistry>;
  containerFetch?: JobCoordinatorDeps["containerFetch"];
} = {}) {
  const storage = opts.storage ?? createFakeStorage();
  const registry = opts.registry ?? createFakeWebSocketRegistry();
  let background: Promise<unknown> = Promise.resolve();
  const deps: JobCoordinatorDeps = {
    env,
    storage,
    waitUntil: (promise) => {
      background = promise;
    },
    containerFetch: opts.containerFetch ?? vi.fn(),
    schedule: vi.fn(async () => undefined),
    deleteSchedules: vi.fn(),
    acceptWebSocket: (server) => registry.accept(server),
    getWebSockets: () => registry.getAll(),
  };
  return { deps, storage, registry, waitForBackground: () => background };
}

function dispatchRequest(body: unknown): Request {
  return new Request("http://do/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function wsRequest(origin = "http://do"): Request {
  return new Request("http://do/ws", {
    headers: { Upgrade: "websocket", Origin: origin },
  });
}

function completedResponse(jobId: string): Response {
  return Response.json({
    jobId,
    status: "completed",
    executionTimeMs: 42,
    taxsea: { packageVersion: "1.4.0" },
    results: {},
  });
}

/** Accepts the client end of a 101 upgrade response and records every `JobState` frame it
 * receives, plus the close code once the server closes it. */
function collectClientMessages(response: Response) {
  const client = response.webSocket;
  if (!client) throw new Error("Expected a webSocket on the 101 response");
  client.accept();
  const messages: JobState[] = [];
  let closeCode: number | undefined;
  client.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
  });
  client.addEventListener("close", (event) => {
    closeCode = event.code;
  });
  return { messages, getCloseCode: () => closeCode };
}

async function readState(storage: ReturnType<typeof createFakeStorage>): Promise<JobState | undefined> {
  return storage.get<JobState>(STATE_KEY);
}

describe("JobCoordinatorDO /ws (Hibernation API)", () => {
  it("connect-then-complete: a client connected while the job is running receives the completion broadcast", async () => {
    const jobId = crypto.randomUUID();
    let resolveContainer!: (response: Response) => void;
    const containerFetch = vi.fn(() => new Promise<Response>((resolve) => (resolveContainer = resolve)));
    const { deps, waitForBackground } = createDeps({ containerFetch });

    const dispatchResponse = await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);

    const wsResponse = await handleFetch(deps, wsRequest());
    expect(wsResponse.status).toBe(101);
    const { messages, getCloseCode } = collectClientMessages(wsResponse);

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ jobId, status: "running" });
    expect(getCloseCode()).toBeUndefined();

    resolveContainer(completedResponse(jobId));
    await waitForBackground();

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ jobId, status: "completed" });
    await vi.waitFor(() => expect(getCloseCode()).toBe(1000));
  });

  it("connect-after-complete: a client connecting after the job finished gets the terminal state immediately", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockResolvedValue(completedResponse(jobId));
    const { deps, waitForBackground } = createDeps({ containerFetch });

    await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    await waitForBackground();

    const wsResponse = await handleFetch(deps, wsRequest());
    expect(wsResponse.status).toBe(101);
    const { messages, getCloseCode } = collectClientMessages(wsResponse);

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ jobId, status: "completed" });
    // Never hangs waiting for a broadcast that already happened -- closed right away.
    await vi.waitFor(() => expect(getCloseCode()).toBe(1000));
  });

  it("rejects a foreign Origin with 403 without ever accepting the socket", async () => {
    const jobId = crypto.randomUUID();
    const containerFetch = vi.fn().mockResolvedValue(completedResponse(jobId));
    const { deps } = createDeps({ containerFetch });

    await handleFetch(deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));

    const response = await handleFetch(deps, wsRequest("https://evil.example"));
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("returns 426 when the Upgrade header isn't websocket", async () => {
    const { deps } = createDeps();
    const response = await handleFetch(deps, new Request("http://do/ws", { headers: { Origin: "http://do" } }));
    expect(response.status).toBe(426);
  });

  it("survives eviction between dispatch and completion: a fresh instance still delivers the broadcast", async () => {
    const jobId = crypto.randomUUID();
    let resolveContainer!: (response: Response) => void;
    const containerFetch = vi.fn(() => new Promise<Response>((resolve) => (resolveContainer = resolve)));

    // "Instance A": dispatches the job and owns the in-flight `runJob` background promise,
    // exactly like the DO that served the original POST /api/jobs.
    const instanceA = createDeps({ containerFetch });
    const dispatchResponse = await handleFetch(instanceA.deps, dispatchRequest({ jobId, mode: "ora", taxa: ["Foo"] }));
    expect(dispatchResponse.status).toBe(201);
    expect((await readState(instanceA.storage))?.status).toBe("running");

    // Simulate the DO being evicted and later reconstructed: a brand new `deps` object, but
    // wired to the SAME durable storage and the SAME WebSocket registry -- exactly what a
    // freshly-constructed JobCoordinatorDO's ctx.storage/ctx.getWebSockets() would return in
    // production, since both are owned by the platform, not by this JS instance
    // (PLAN.md #1.3: the old bug was a `Set<WebSocket>` field that a fresh instance would
    // NOT share, and this test's whole point is that nothing here is threaded through such
    // an instance-local field).
    const instanceB = createDeps({ storage: instanceA.storage, registry: instanceA.registry });

    const wsResponse = await handleFetch(instanceB.deps, wsRequest());
    expect(wsResponse.status).toBe(101);
    const { messages } = collectClientMessages(wsResponse);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ jobId, status: "running" });

    // The container response that instance A's runJob is still awaiting finally arrives;
    // finalizeState runs against instance A's deps, but broadcasts through the shared
    // registry -- reaching the socket that connected via instance B.
    resolveContainer(completedResponse(jobId));
    await instanceA.waitForBackground();

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ jobId, status: "completed" });
  });
});
