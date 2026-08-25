/**
 * Shapes shared between the router (issue #11), `JobCoordinatorDO`, and the compute
 * container. See `/docs/api.md` for the frozen contracts these mirror.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "timed_out";

/** Stored under DO storage key `state`; the only object pushed over `/ws` and returned by
 * `GET /state` (docs/api.md #3). */
export interface JobState {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  executionTimeMs?: number;
  error?: string;
}

/**
 * The already-validated `POST /api/jobs` submission body, minus `jobId` (docs/api.md #1).
 * Validating `mode`/`ranks`/`taxa`/`options` is the public router's job (issue #11) -- the
 * DO treats this as opaque data it forwards to the container by value and never inspects.
 */
export type JobPayload = Record<string, unknown>;

/** The internal DO -> container `/run` response (docs/api.md #2). Both variants are HTTP
 * 200; a non-2xx or thrown error is a separate, infrastructure-level failure handled by the
 * DO and never reaches this type. */
export type ContainerRunResponse =
  | ({ jobId: string; status: "completed"; executionTimeMs: number } & Record<string, unknown>)
  | { jobId: string; status: "failed"; executionTimeMs?: number; error: string };
