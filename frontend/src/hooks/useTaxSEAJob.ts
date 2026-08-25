// Issue #15: WebSocket job-progress hook with a polling fallback.
//
// The connection/reconnect/poll state machine lives in `createJobConnection`, a plain
// function with no React dependency, so it's testable with a mock WebSocket/fetch and no
// DOM/rendering harness (see useTaxSEAJob.test.ts). `useTaxSEAJob` is a thin useState/
// useEffect wrapper that owns the connection's lifecycle for one `jobId`.
import { useEffect, useState } from 'react';

/** Mirrors docs/api.md §3 exactly. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out';

export interface JobState {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  executionTimeMs: number | null;
  error: string | null;
}

/** One `results` entry in the output.json envelope (docs/api.md §8). Collection names and
 * column sets are whatever TaxSEA returns -- never hardcode them. */
export interface TaxSEAResultCollection {
  columns: string[];
  rows: Array<Record<string, number | string | null>>;
}

/** `output.json` envelope, docs/api.md §8. */
export interface TaxSEAOutput {
  jobId: string;
  status: 'completed';
  executionTimeMs: number;
  taxsea: {
    packageVersion: string;
    mode: 'enrichment' | 'ora';
    params: { minSetSize: number; maxSetSize: number };
  };
  results: Record<string, TaxSEAResultCollection>;
}

export type Connection = 'connecting' | 'live' | 'polling' | 'closed';

export interface JobConnectionState {
  state: JobState | null;
  result: TaxSEAOutput | null;
  error: string | null;
  connection: Connection;
  /** UI-facing cold-start hint (additive to the issue's interface): every job boots a fresh
   * container, so the first ~45s of `running` is normal, not stuck. Null once past that
   * window, or whenever status isn't `running` -- consumer falls back to a plain spinner. */
  message: string | null;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000];
const POLL_INTERVAL_MS = 3000;
// JOB_TIMEOUT_MS is 300000 in edge/wrangler.toml; pad so the client-side cap never fires
// before the server's own timeout would already have produced a terminal `timed_out` state.
const CLIENT_TIMEOUT_MS = 330000;
const COLD_START_WINDOW_MS = 45000;

function wsUrl(jobId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/jobs/${jobId}/ws`;
}

function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out';
}

function coldStartMessage(state: JobState): string | null {
  if (state.status !== 'running' || state.startedAt === null) return null;
  return Date.now() - state.startedAt < COLD_START_WINDOW_MS ? 'Starting analysis environment…' : null;
}

interface Callbacks {
  onChange: (patch: Partial<JobConnectionState>) => void;
}

/** Framework-agnostic connection/reconnect/poll state machine for one job. */
export function createJobConnection(jobId: string, { onChange }: Callbacks): { dispose: () => void } {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let done = false; // terminal state reached, timed out, or disposed -- stop reacting.

  function clearTimers() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function closeSocket() {
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      socket = null;
    }
  }

  function finish() {
    done = true;
    clearTimers();
    closeSocket();
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  async function fetchResult() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/result`);
      if (disposed) return;
      if (!res.ok) throw new Error(`result fetch failed (${res.status})`);
      const data = (await res.json()) as TaxSEAOutput;
      if (disposed) return;
      onChange({ result: data });
    } catch {
      if (disposed) return;
      onChange({ error: 'Could not load the result. Try refreshing.' });
    }
  }

  function applyState(next: JobState) {
    onChange({ state: next, error: null, message: coldStartMessage(next) });
    if (isTerminal(next.status)) {
      finish();
      onChange({ connection: 'closed' });
      if (next.status === 'completed') void fetchResult();
    }
  }

  function startPolling() {
    if (done || disposed) return;
    clearTimers();
    onChange({ connection: 'polling' });
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/state`);
        if (disposed || done) return;
        if (!res.ok) throw new Error(`state fetch failed (${res.status})`);
        const data = (await res.json()) as JobState;
        if (disposed || done) return;
        applyState(data);
      } catch {
        if (disposed || done) return;
        onChange({ error: 'Lost connection to the server.' });
      }
    };
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
  }

  function scheduleReconnect() {
    if (done || disposed) return;
    if (reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      startPolling();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[reconnectAttempts] ?? 4000;
    reconnectAttempts++;
    onChange({ connection: 'connecting' });
    reconnectTimer = setTimeout(connectSocket, delay);
  }

  function connectSocket() {
    if (done || disposed) return;
    try {
      socket = new WebSocket(wsUrl(jobId));
    } catch {
      startPolling();
      return;
    }
    socket.onopen = () => {
      onChange({ connection: 'live' });
    };
    socket.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as JobState;
        if (typeof data?.status !== 'string') throw new Error('malformed state message');
        applyState(data);
      } catch {
        onChange({ error: 'Received a malformed update from the server.' });
      }
    };
    socket.onclose = () => {
      if (done || disposed) return;
      scheduleReconnect();
    };
    // onerror is always followed by onclose per the WebSocket spec; reconnect/poll logic
    // lives there so it isn't duplicated.
    socket.onerror = () => {};
  }

  timeoutTimer = setTimeout(() => {
    if (done) return;
    onChange({ error: 'This job is taking longer than expected. Please try again later.', connection: 'closed' });
    finish();
  }, CLIENT_TIMEOUT_MS);

  connectSocket();

  return {
    dispose() {
      disposed = true;
      finish();
    },
  };
}

const IDLE_STATE: JobConnectionState = { state: null, result: null, error: null, connection: 'closed', message: null };
const CONNECTING_STATE: JobConnectionState = { ...IDLE_STATE, connection: 'connecting' };

export default function useTaxSEAJob(jobId: string | null): JobConnectionState {
  const [connState, setConnState] = useState<JobConnectionState>(jobId ? CONNECTING_STATE : IDLE_STATE);

  // Reset synchronously during render when `jobId` changes, per React's guidance for
  // "adjusting state when a prop changes" -- avoids the cascading-render effect that a
  // setState call in the effect body below would otherwise cause.
  const [prevJobId, setPrevJobId] = useState(jobId);
  if (jobId !== prevJobId) {
    setPrevJobId(jobId);
    setConnState(jobId ? CONNECTING_STATE : IDLE_STATE);
  }

  useEffect(() => {
    if (!jobId) return;
    const conn = createJobConnection(jobId, {
      onChange: (patch) => setConnState((prev) => ({ ...prev, ...patch })),
    });
    return () => conn.dispose();
  }, [jobId]);

  return connState;
}
