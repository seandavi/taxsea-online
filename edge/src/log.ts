export type LogLevel = "info" | "warn" | "error";

/**
 * Structured single-line JSON logging for the edge side (issue #22) -- no framework, just
 * `console.log(JSON.stringify(...))` so `wrangler tail` output is one JSON object per line
 * and a job's whole trace across index.ts and JobCoordinatorDO.ts can be pulled with
 * `wrangler tail | jq 'select(.jobId == "...")'` (see docs/development.md).
 *
 * Never pass user-supplied content (taxon names, ranks, request/response bodies) in `fields`
 * -- log counts/sizes instead.
 */
export function log(component: string, level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: Date.now(), level, component, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
