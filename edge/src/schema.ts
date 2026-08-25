/**
 * Hand-rolled validation for the `POST /api/jobs` body (docs/api.md #5). No schema library --
 * the rules are small and fixed enough that 40 lines of TypeScript beats a dependency
 * (issue #11).
 */

const NAME_RE = /^[A-Za-z0-9_. -]{1,200}$/;
const MIN_SET_SIZE = 2;
const MAX_SET_SIZE = 1000;
const DEFAULT_MIN_SET_SIZE = 5;
const DEFAULT_MAX_SET_SIZE = 100;
const TOP_LEVEL_KEYS = new Set(["mode", "ranks", "taxa", "options", "jobId"]);

export interface ValidationError {
  error: "invalid_request";
  field: string;
  message: string;
}

export interface ValidatedJob {
  mode: "enrichment" | "ora";
  ranks?: Record<string, number>;
  taxa?: string[];
  options: { minSetSize: number; maxSetSize: number };
}

function fail(field: string, message: string): ValidationError {
  return { error: "invalid_request", field, message };
}

function isError<T>(result: T | ValidationError): result is ValidationError {
  return typeof result === "object" && result !== null && "error" in result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateName(name: unknown, field: string): string | ValidationError {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return fail(field, `taxon names must match ${NAME_RE.source}`);
  }
  return name;
}

function validateRanks(raw: unknown, maxTaxa: number): Record<string, number> | ValidationError {
  if (!isPlainObject(raw)) {
    return fail("ranks", "ranks must be an object mapping taxon name to a finite numeric rank");
  }
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > maxTaxa) {
    return fail("ranks", `ranks must contain between 1 and ${maxTaxa} entries`);
  }
  const ranks: Record<string, number> = {};
  for (const [name, value] of entries) {
    const validName = validateName(name, "ranks");
    if (isError(validName)) return validName;
    // Reject NaN, Infinity, -Infinity, and numeric strings (docs/api.md #5).
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail("ranks", `rank for "${name}" must be a finite number`);
    }
    ranks[validName] = value;
  }
  return ranks;
}

function validateTaxa(raw: unknown, maxTaxa: number): string[] | ValidationError {
  if (!Array.isArray(raw)) {
    return fail("taxa", "taxa must be an array of taxon names");
  }
  if (raw.length < 1 || raw.length > maxTaxa) {
    return fail("taxa", `taxa must contain between 1 and ${maxTaxa} entries`);
  }
  const taxa: string[] = [];
  for (const name of raw) {
    const validName = validateName(name, "taxa");
    if (isError(validName)) return validName;
    taxa.push(validName);
  }
  return taxa;
}

function readSetSize(raw: unknown, fallback: number, field: string): number | ValidationError {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(field, `${field} must be a finite number`);
  }
  return Math.min(MAX_SET_SIZE, Math.max(MIN_SET_SIZE, raw));
}

function validateOptions(
  raw: unknown,
): { minSetSize: number; maxSetSize: number } | ValidationError {
  if (raw === undefined) {
    return { minSetSize: DEFAULT_MIN_SET_SIZE, maxSetSize: DEFAULT_MAX_SET_SIZE };
  }
  if (!isPlainObject(raw)) {
    return fail("options", "options must be an object");
  }
  const minSetSize = readSetSize(raw.minSetSize, DEFAULT_MIN_SET_SIZE, "minSetSize");
  if (isError(minSetSize)) return minSetSize;
  const maxSetSize = readSetSize(raw.maxSetSize, DEFAULT_MAX_SET_SIZE, "maxSetSize");
  if (isError(maxSetSize)) return maxSetSize;
  if (minSetSize >= maxSetSize) {
    return fail("minSetSize", "minSetSize must be less than maxSetSize");
  }
  return { minSetSize, maxSetSize };
}

/** Validates and normalizes a parsed `POST /api/jobs` body. Never trusts a client-supplied
 * `jobId` -- it is accepted as a known top-level key (so a body containing one isn't rejected
 * as "unknown key") but always dropped; the router mints its own (docs/api.md #4). */
export function validateJobPayload(body: unknown, maxTaxa: number): ValidatedJob | ValidationError {
  if (!isPlainObject(body)) {
    return fail("body", "Request body must be a JSON object");
  }

  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return fail(key, `unknown field: ${key}`);
    }
  }

  if (body.mode !== "enrichment" && body.mode !== "ora") {
    return fail("mode", 'mode must be "enrichment" or "ora"');
  }

  const options = validateOptions(body.options);
  if (isError(options)) return options;

  if (body.mode === "enrichment") {
    const ranks = validateRanks(body.ranks, maxTaxa);
    if (isError(ranks)) return ranks;
    return { mode: "enrichment", ranks, options };
  }

  const taxa = validateTaxa(body.taxa, maxTaxa);
  if (isError(taxa)) return taxa;
  return { mode: "ora", taxa, options };
}
