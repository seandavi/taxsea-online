// Tests target `createJobConnection`, the framework-agnostic core `useTaxSEAJob` wraps --
// no DOM/rendering harness needed, just a mock WebSocket and mock fetch (issue #15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobConnection, type JobConnectionState, type JobState, type TaxSEAOutput } from './useTaxSEAJob';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  triggerRaw(data: string) {
    this.onmessage?.({ data });
  }
  triggerClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function jobState(overrides: Partial<JobState> = {}): JobState {
  return {
    jobId: 'job-1',
    status: 'queued',
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    executionTimeMs: null,
    error: null,
    ...overrides,
  };
}

const OUTPUT: TaxSEAOutput = {
  jobId: 'job-1',
  status: 'completed',
  executionTimeMs: 100,
  taxsea: { packageVersion: '1.4.0', mode: 'enrichment', params: { minSetSize: 5, maxSetSize: 100 } },
  results: { All_databases: { columns: ['taxonSetName'], rows: [{ taxonSetName: 'x' }] } },
};

/** Accumulates onChange patches into a single observable snapshot, like the hook's setState does. */
function watcher() {
  let snapshot: JobConnectionState = { state: null, result: null, error: null, connection: 'closed', message: null };
  return {
    onChange: (patch: Partial<JobConnectionState>) => {
      snapshot = { ...snapshot, ...patch };
    },
    get: () => snapshot,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('window', { location: { protocol: 'https:', host: 'example.test' } });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createJobConnection', () => {
  it('happy path: opens wss:// derived from window.location, streams state, fetches result on completion', async () => {
    const { onChange, get } = watcher();
    const conn = createJobConnection('job-1', { onChange });

    expect(MockWebSocket.instances[0]?.url).toBe('wss://example.test/api/jobs/job-1/ws');
    MockWebSocket.instances[0]?.triggerOpen();
    expect(get().connection).toBe('live');

    MockWebSocket.instances[0]?.triggerMessage(jobState({ status: 'running', startedAt: Date.now() }));
    expect(get().state?.status).toBe('running');
    expect(get().message).toMatch(/starting analysis environment/i);

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => OUTPUT });
    MockWebSocket.instances[0]?.triggerMessage(jobState({ status: 'completed', startedAt: Date.now(), finishedAt: Date.now() }));
    expect(get().connection).toBe('closed');

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-1/result');
    expect(get().result).toEqual(OUTPUT);

    conn.dispose();
  });

  it('uses ws:// on an insecure origin', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'example.test' } });
    const { onChange } = watcher();
    createJobConnection('job-1', { onChange });
    expect(MockWebSocket.instances[0]?.url).toBe('ws://example.test/api/jobs/job-1/ws');
  });

  it('falls back to polling after 3 backoff reconnects (1s/2s/4s) fail', async () => {
    const { onChange, get } = watcher();
    createJobConnection('job-1', { onChange });
    fetchMock.mockResolvedValue({ ok: true, json: async () => jobState({ status: 'running' }) });

    MockWebSocket.instances[0]?.triggerClose(); // unexpected close before terminal -> reconnect #1 (1s)
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1]?.triggerClose(); // reconnect #2 (2s)
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.instances[2]?.triggerClose(); // reconnect #3 (4s)
    await vi.advanceTimersByTimeAsync(4000);
    expect(MockWebSocket.instances).toHaveLength(4);

    MockWebSocket.instances[3]?.triggerClose(); // reconnects exhausted -> polling
    await vi.advanceTimersByTimeAsync(0);
    expect(get().connection).toBe('polling');
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-1/state');

    // Polling continues on its own 3s cadence.
    const callsBefore = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('reconnects once, then succeeds and keeps streaming state', async () => {
    const { onChange, get } = watcher();
    createJobConnection('job-1', { onChange });

    MockWebSocket.instances[0]?.triggerClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1]?.triggerOpen();
    expect(get().connection).toBe('live');

    MockWebSocket.instances[1]?.triggerMessage(jobState({ status: 'running', startedAt: Date.now() }));
    expect(get().state?.status).toBe('running');

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => OUTPUT });
    MockWebSocket.instances[1]?.triggerMessage(jobState({ status: 'completed' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(get().result).toEqual(OUTPUT);
  });

  it('sets error (not throw) when the result fetch fails after completion', async () => {
    const { onChange, get } = watcher();
    createJobConnection('job-1', { onChange });
    MockWebSocket.instances[0]?.triggerOpen();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(() => MockWebSocket.instances[0]?.triggerMessage(jobState({ status: 'completed' }))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(get().result).toBeNull();
    expect(get().error).toMatch(/could not load the result/i);
  });

  it('sets error (not throw) on a malformed WebSocket message', () => {
    const { onChange, get } = watcher();
    createJobConnection('job-1', { onChange });
    MockWebSocket.instances[0]?.triggerOpen();

    expect(() => MockWebSocket.instances[0]?.triggerRaw('not json')).not.toThrow();
    expect(get().error).toMatch(/malformed/i);
  });

  it('resumes correctly when the DO sends an already-terminal state on connect (page refresh after completion)', async () => {
    const { onChange, get } = watcher();
    createJobConnection('job-1', { onChange });
    MockWebSocket.instances[0]?.triggerOpen();

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => OUTPUT });
    MockWebSocket.instances[0]?.triggerMessage(jobState({ status: 'completed', finishedAt: 5 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(get().state?.status).toBe('completed');
    expect(get().result).toEqual(OUTPUT);
  });

  it('cleanup: dispose() closes the socket and clears pending reconnect/poll timers (no leaks)', async () => {
    const { onChange } = watcher();
    const conn = createJobConnection('job-1', { onChange });
    const first = MockWebSocket.instances[0];

    conn.dispose();
    expect(first?.closed).toBe(true);

    // A reconnect/poll timer must not still be pending after dispose.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWebSocket.instances).toHaveLength(1); // no reconnect fired
    expect(fetchMock).not.toHaveBeenCalled(); // no poll fired
  });

  it('cleanup: dispose() while polling stops further /state polls', async () => {
    const { onChange, get } = watcher();
    const conn = createJobConnection('job-1', { onChange });
    fetchMock.mockResolvedValue({ ok: true, json: async () => jobState({ status: 'running' }) });

    // Force straight to polling by failing the initial connect + all 3 reconnects.
    MockWebSocket.instances[0]?.triggerClose();
    await vi.advanceTimersByTimeAsync(1000);
    MockWebSocket.instances[1]?.triggerClose();
    await vi.advanceTimersByTimeAsync(2000);
    MockWebSocket.instances[2]?.triggerClose();
    await vi.advanceTimersByTimeAsync(4000);
    MockWebSocket.instances[3]?.triggerClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(get().connection).toBe('polling');

    const callsBefore = fetchMock.mock.calls.length;
    conn.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // no further polls after dispose
  });
});
