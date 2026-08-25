// GET /api/health -- issue #12. Org convention: 200 + a plain-text body containing "Healthy"
// when all checks pass, else 503 naming the failed dependency. Unauthenticated by design (an
// external uptime check hits this with no credentials); the response never echoes bucket
// names, secrets, or any other config.

const HEALTH_CHECK_TIMEOUT_MS = 3000;
// Fixed id so this never collides with a real job's DO instance.
const HEALTH_PROBE_DO_NAME = "__health__";

/** Bounds a check's wall time -- R2/DO calls have no built-in timeout, and the endpoint must
 * stay under 5s total even when a dependency hangs rather than erroring quickly. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** list({ limit: 1 }) rather than head on a sentinel key -- proves the R2 binding round-trips
 * without depending on any particular object existing in the bucket. */
function checkR2(env: Env): Promise<unknown> {
  return withTimeout(env.TAXSEA_BUCKET.list({ limit: 1 }), HEALTH_CHECK_TIMEOUT_MS);
}

/**
 * Hits /state on a fixed health-probe DO id. JobCoordinatorDO's fetch() (handleFetch in
 * JobCoordinatorDO.ts) handles /state entirely inside the DO and never calls containerFetch for
 * it -- so this round-trips the Durable Object binding without booting anything. The probe DO
 * has no job dispatched to it, so /state 404s ("No job found for this id"); that 404 *is* the
 * successful round-trip -- the DO responded. Only a thrown/network-level failure (the DO
 * unreachable) counts as this check failing.
 *
 * The container itself is deliberately never probed here: pulling and starting its multi-GB
 * image on every health check would cost more than the rest of the service combined and defeat
 * scale-to-zero (JobCoordinatorDO.sleepAfter). Container readiness is already covered by
 * `pingEndpoint` on the container class (issue #9) -- do not "fix" this by adding a container
 * check.
 */
function checkDurableObject(env: Env): Promise<unknown> {
  const stub = env.JOB_COORDINATOR.get(env.JOB_COORDINATOR.idFromName(HEALTH_PROBE_DO_NAME));
  return withTimeout(stub.fetch("http://do/state"), HEALTH_CHECK_TIMEOUT_MS);
}

export async function handleHealth(env: Env): Promise<Response> {
  const [r2, durableObject] = await Promise.allSettled([checkR2(env), checkDurableObject(env)]);

  const failed: string[] = [];
  if (r2.status === "rejected") failed.push("R2");
  if (durableObject.status === "rejected") failed.push("DurableObject");

  if (failed.length === 0) {
    return new Response("Healthy", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(`Unhealthy: ${failed.join(", ")} unreachable`, {
    status: 503,
    headers: { "Content-Type": "text/plain" },
  });
}
