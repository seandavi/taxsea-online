// `class_name = "JobCoordinatorDO"` in wrangler.toml's `[[containers]]` and
// `[[durable_objects.bindings]]` resolves against this main module's exports (`main =
// "src/index.ts"`), so the class has to stay re-exported here even though it now lives in
// its own file (issue #9).
export { JobCoordinatorDO } from "./JobCoordinatorDO";

import { handleHealth } from "./health";
import { log } from "./log";
import { validateJobPayload } from "./schema";

// docs/api.md #4.
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// docs/api.md #5.
const MAX_BODY_BYTES = 1024 * 1024;
// Mirrors wrangler.toml's [[ratelimits.simple]] period -- the RateLimit binding's response
// carries no reset time, so this is the best Retry-After hint available (docs/api.md #6).
const RATE_LIMIT_PERIOD_SECONDS = 60;

function jsonError(status: number, error: string, message: string, field?: string): Response {
  return Response.json(field !== undefined ? { error, field, message } : { error, message }, {
    status,
  });
}

/** Rejects an unparseable or oversized body before it ever reaches JSON.parse -- an accepted
 * request boots a multi-GB container, so rejection has to stay cheap (docs/api.md #5). */
async function readBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  return text;
}

async function checkRateLimit(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  if (success) return null;
  log("index", "warn", "job rejected: rate limited", {});
  return jsonError(429, "rate_limited", "Too many job submissions. Try again shortly.");
  // Retry-After is set by the caller, which has access to the Response to patch a header onto.
}

async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const rateLimited = await checkRateLimit(request, env);
  if (rateLimited) {
    rateLimited.headers.set("Retry-After", String(RATE_LIMIT_PERIOD_SECONDS));
    return rateLimited;
  }

  const rawBody = await readBody(request);
  if (rawBody === null) {
    return jsonError(413, "invalid_request", "Request body exceeds 1 MiB", "body");
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid_request", "Body must be valid JSON", "body");
  }

  const validated = validateJobPayload(body, env.MAX_TAXA);
  if ("error" in validated) {
    // field is a schema key name (e.g. "taxa"), never submitted content.
    log("index", "warn", "job rejected: invalid payload", { error: validated.error, field: validated.field });
    return Response.json(validated, { status: 400 });
  }

  // Server-generated only -- any jobId the client sent was dropped by validateJobPayload and
  // never reaches this point (docs/api.md #4).
  const jobId = crypto.randomUUID();
  const stub = env.JOB_COORDINATOR.get(env.JOB_COORDINATOR.idFromName(jobId));

  const dispatchBody: Record<string, unknown> = {
    jobId,
    mode: validated.mode,
    options: validated.options,
    ...(validated.mode === "enrichment" ? { ranks: validated.ranks } : { taxa: validated.taxa }),
  };

  // Counts/sizes only -- never the taxa/ranks themselves (docs/api.md #6, issue #22).
  log("index", "info", "job dispatch requested", {
    jobId,
    mode: validated.mode,
    ...(validated.mode === "enrichment"
      ? { ranksCount: Object.keys(validated.ranks ?? {}).length }
      : { taxaCount: (validated.taxa ?? []).length }),
  });

  const doResponse = await stub.fetch("http://do/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dispatchBody),
  });
  if (!doResponse.ok) {
    log("index", "error", "job dispatch rejected by coordinator", { jobId, status: doResponse.status });
    // Forward the DO's own {error, message} body verbatim rather than reinventing it.
    return new Response(doResponse.body, { status: doResponse.status, headers: doResponse.headers });
  }
  log("index", "info", "job dispatch accepted", { jobId, status: doResponse.status });

  return Response.json(
    {
      jobId,
      status: "queued",
      wsUrl: `/api/jobs/${jobId}/ws`,
      stateUrl: `/api/jobs/${jobId}/state`,
      resultUrl: `/api/jobs/${jobId}/result`,
    },
    { status: 201 },
  );
}

/** Forwards a read (`/state` or `/ws`) to the DO instance addressed by `jobId`. Not rate
 * limited -- only POST /api/jobs is (docs/api.md #6).
 *
 * The internal request keeps the real origin/protocol/host and only swaps the pathname
 * (public `/api/jobs/:jobId/ws` -> internal `/ws`) -- a placeholder origin like
 * `http://do` would make `JobCoordinatorDO`'s own `Origin`-header check
 * (`new URL(request.url).origin`) compare against a value that can never match a real
 * client's `Origin` header, silently 403-ing every WebSocket connection in production
 * (found via the real deployed smoke test, issue #23 -- unit tests never caught this
 * because they call `handleFetch`/`handleRequest` directly with a real request URL,
 * never through this rewrite). */
function forwardToDO(env: Env, jobId: string, path: string, request: Request): Promise<Response> {
  const stub = env.JOB_COORDINATOR.get(env.JOB_COORDINATOR.idFromName(jobId));
  const internalUrl = new URL(path, request.url);
  return stub.fetch(new Request(internalUrl, request));
}

async function handleResult(env: Env, jobId: string): Promise<Response> {
  const object = await env.TAXSEA_BUCKET.get(`jobs/${jobId}/output.json`);
  if (!object) {
    log("index", "info", "job result requested: not found", { jobId });
    return jsonError(404, "not_found", "No result available for this job");
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // The object is immutable once written (docs/api.md #7).
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/** Adds the security headers required on HTML responses (issue #11) without touching
 * non-HTML asset responses (JS/CSS/images already carry their own correct content types). */
function withSecurityHeaders(response: Response): Response {
  if (!response.headers.get("Content-Type")?.includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const JOB_SUBROUTE_RE = /^\/api\/jobs\/([^/]+)\/(state|ws|result)$/;

/** The whole router. Exported (not just the default handler) so tests can call it directly
 * with an `env` that swaps in a fake `JOB_COORDINATOR` -- constructing a real
 * `JobCoordinatorDO` isn't possible under `@cloudflare/vitest-plugin` (see the doc comment on
 * `JobCoordinatorDeps` in JobCoordinatorDO.ts), so routes that would dispatch to it are tested
 * against a fake stub while every other binding (R2, the rate limiter, ASSETS) stays real. */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health" && request.method === "GET") {
    return handleHealth(env);
  }

  if (pathname === "/api/jobs" && request.method === "POST") {
    return handleCreateJob(request, env);
  }

  const match = pathname.match(JOB_SUBROUTE_RE);
  if (match && request.method === "GET") {
    const jobId = match[1]!;
    const action = match[2]!;
    // Validated before touching JOB_COORDINATOR or TAXSEA_BUCKET -- defense in depth against
    // path traversal, on top of the fact that jobId is never client-supplied (docs/api.md #4).
    if (!JOB_ID_RE.test(jobId)) {
      return jsonError(400, "invalid_request", "jobId must be a valid UUID", "jobId");
    }
    if (action === "result") return handleResult(env, jobId);
    return forwardToDO(env, jobId, `/${action}`, request);
  }

  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
