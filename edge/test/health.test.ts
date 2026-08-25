import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";

function getHealth(): Request {
  return new Request("https://example.com/api/health");
}

/** Fake JOB_COORDINATOR stub, same shape as router.test.ts's envWithFakeCoordinator -- a real
 * JobCoordinatorDO can't be constructed under @cloudflare/vitest-plugin (see JobCoordinatorDeps'
 * doc comment in JobCoordinatorDO.ts). Records every path the health check hits, so tests can
 * assert /dispatch (the only route that ever calls containerFetch) is never reached. */
function envWithFakeCoordinator(paths: string[]): Env {
  const fakeCoordinator = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        paths.push(new URL(url).pathname);
        // A probe DO with no dispatched job 404s from /state -- that's a valid round-trip.
        return new Response("Not Found", { status: 404 });
      },
    }),
  } as unknown as Env["JOB_COORDINATOR"];
  return { ...env, JOB_COORDINATOR: fakeCoordinator };
}

describe("GET /api/health", () => {
  it("returns 200 with a body containing Healthy when R2 and the DO both respond", async () => {
    const fakeEnv = envWithFakeCoordinator([]);
    const response = await handleRequest(getHealth(), fakeEnv);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Healthy");
  });

  it("returns 503 naming R2 when the R2 binding is unreachable", async () => {
    const brokenBucket = {
      list: async () => {
        throw new Error("R2 down");
      },
    } as unknown as Env["TAXSEA_BUCKET"];
    const fakeEnv = { ...envWithFakeCoordinator([]), TAXSEA_BUCKET: brokenBucket };

    const response = await handleRequest(getHealth(), fakeEnv);
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("R2");
  });

  it("never dispatches a job, so no container is ever started", async () => {
    const paths: string[] = [];
    const fakeEnv = envWithFakeCoordinator(paths);

    await handleRequest(getHealth(), fakeEnv);

    expect(paths).not.toContain("/dispatch");
    expect(paths).toEqual(["/state"]);
  });
});
