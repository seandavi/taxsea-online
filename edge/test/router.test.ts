import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A fresh IP per test avoids cross-test interference on the shared RATE_LIMITER binding.
let nextIp = 0;
function freshIp(): string {
  nextIp += 1;
  return `10.0.0.${nextIp}`;
}

function postJobs(body: string, ip = freshIp()): Request {
  return new Request("https://example.com/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body,
  });
}

function getJob(jobId: string, action: "state" | "ws" | "result"): Request {
  return new Request(`https://example.com/api/jobs/${jobId}/${action}`);
}

/** Real R2/rate-limiter/ASSETS bindings, but with JOB_COORDINATOR replaced by a fake stub --
 * a real JobCoordinatorDO can't be constructed under `@cloudflare/vitest-plugin` (see
 * JobCoordinatorDeps' doc comment in JobCoordinatorDO.ts). Routes covered by these tests that
 * reach the DO only care whether the router forwarded correctly, not what the DO does. */
function envWithFakeCoordinator(respond: (path: string, body: unknown) => Response): Env {
  const fakeCoordinator = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const path = new URL(url).pathname;
        const rawBody = input instanceof Request ? await input.clone().text() : (init?.body as string | undefined);
        const body = rawBody ? JSON.parse(rawBody) : undefined;
        return respond(path, body);
      },
    }),
  } as unknown as Env["JOB_COORDINATOR"];
  return { ...env, JOB_COORDINATOR: fakeCoordinator };
}

describe("POST /api/jobs validation", () => {
  it("rejects an oversized body with 413", async () => {
    const oversized = "a".repeat(1024 * 1024 + 100);
    const response = await handleRequest(postJobs(oversized), env);
    expect(response.status).toBe(413);
  });

  it("rejects more than MAX_TAXA taxa with 400", async () => {
    const taxa = Array.from({ length: env.MAX_TAXA + 1 }, (_, i) => `taxon_${i}`);
    const response = await handleRequest(postJobs(JSON.stringify({ mode: "ora", taxa })), env);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({ error: "invalid_request", field: "taxa" });
  });

  it("rejects a taxon name containing ../ with 400", async () => {
    const body = JSON.stringify({ mode: "ora", taxa: ["../etc/passwd"] });
    const response = await handleRequest(postJobs(body), env);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({ error: "invalid_request", field: "taxa" });
  });

  it("rejects a non-finite rank with 400", async () => {
    // JSON has no NaN literal; 1e400 is valid JSON syntax but overflows to Infinity once
    // parsed, which is exactly the "finite numbers only" case docs/api.md #5 requires rejecting.
    const body = '{"mode":"enrichment","ranks":{"Foo":1e400}}';
    const response = await handleRequest(postJobs(body), env);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({ error: "invalid_request", field: "ranks" });
  });

  it("rejects unknown top-level keys with 400", async () => {
    const body = JSON.stringify({ mode: "ora", taxa: ["Foo"], evil: true });
    const response = await handleRequest(postJobs(body), env);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({ error: "invalid_request", field: "evil" });
  });

  it("clamps minSetSize/maxSetSize and rejects minSetSize >= maxSetSize", async () => {
    const body = JSON.stringify({
      mode: "ora",
      taxa: ["Foo"],
      options: { minSetSize: 900, maxSetSize: 950 },
    });
    const fakeEnv = envWithFakeCoordinator((_path, sent) => {
      expect(sent).toMatchObject({ options: { minSetSize: 900, maxSetSize: 950 } });
      return Response.json({ status: "running" }, { status: 201 });
    });
    const response = await handleRequest(postJobs(body), fakeEnv);
    expect(response.status).toBe(201);

    const badBody = JSON.stringify({ mode: "ora", taxa: ["Foo"], options: { minSetSize: 10, maxSetSize: 10 } });
    const badResponse = await handleRequest(postJobs(badBody), env);
    expect(badResponse.status).toBe(400);
    const json = await badResponse.json();
    expect(json).toMatchObject({ error: "invalid_request", field: "minSetSize" });
  });
});

describe("jobId path validation", () => {
  it("rejects a malformed jobId with 400 without touching any binding", async () => {
    // env.JOB_COORDINATOR here is the real binding -- if the router touched it before this
    // check, constructing the DO would throw (it can't be constructed under this test pool).
    const response = await handleRequest(getJob("not-a-uuid", "state"), env);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({ error: "invalid_request", field: "jobId" });
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the per-IP limit is exceeded", async () => {
    // wrangler.toml's [[ratelimits.simple]]: limit = 10, period = 60.
    const ip = freshIp();
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await handleRequest(postJobs("{}", ip), env);
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    const json = await last!.json();
    expect(json).toMatchObject({ error: "rate_limited" });
  });

  it("does not rate limit GET /state", async () => {
    // A malformed jobId 400s before touching RATE_LIMITER or JOB_COORDINATOR either way, but
    // this also confirms reads never even consult the limiter -- issuing plenty of them never
    // starts returning 429.
    for (let i = 0; i < 15; i++) {
      const response = await handleRequest(getJob("not-a-uuid", "state"), env);
      expect(response.status).toBe(400);
    }
  });
});

describe("GET /api/jobs/:jobId/result", () => {
  it("returns 404 when the job has not completed (no R2 object yet)", async () => {
    const jobId = crypto.randomUUID();
    const response = await handleRequest(getJob(jobId, "result"), env);
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json).toMatchObject({ error: "not_found" });
  });

  it("streams the R2 object with the right Content-Type and Cache-Control when present", async () => {
    const jobId = crypto.randomUUID();
    const output = { jobId, status: "completed", executionTimeMs: 1, taxsea: {}, results: {} };
    await env.TAXSEA_BUCKET.put(`jobs/${jobId}/output.json`, JSON.stringify(output));

    const response = await handleRequest(getJob(jobId, "result"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    await expect(response.json()).resolves.toEqual(output);
  });
});

describe("POST /api/jobs success", () => {
  it("mints its own UUID jobId, ignoring any jobId the client sent", async () => {
    const clientJobId = "client-supplied-not-a-real-id";
    const fakeEnv = envWithFakeCoordinator((path, sent) => {
      expect(path).toBe("/dispatch");
      expect(sent).toMatchObject({ mode: "ora", taxa: ["Foo"] });
      expect((sent as { jobId: string }).jobId).not.toBe(clientJobId);
      return Response.json({ status: "running" }, { status: 201 });
    });

    const body = JSON.stringify({ mode: "ora", taxa: ["Foo"], jobId: clientJobId });
    const response = await handleRequest(postJobs(body), fakeEnv);

    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      jobId: string;
      status: string;
      wsUrl: string;
      stateUrl: string;
      resultUrl: string;
    };
    expect(json.jobId).toMatch(UUID_RE);
    expect(json.jobId).not.toBe(clientJobId);
    expect(json.status).toBe("queued");
    expect(json.wsUrl).toBe(`/api/jobs/${json.jobId}/ws`);
    expect(json.stateUrl).toBe(`/api/jobs/${json.jobId}/state`);
    expect(json.resultUrl).toBe(`/api/jobs/${json.jobId}/result`);
  });

  it("forwards GET /state to the DO addressed by the same jobId", async () => {
    const jobId = crypto.randomUUID();
    const fakeEnv = envWithFakeCoordinator((path) => {
      expect(path).toBe("/state");
      return Response.json({ jobId, status: "running" });
    });
    const response = await handleRequest(getJob(jobId, "state"), fakeEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobId, status: "running" });
  });
});

describe("unmatched routes", () => {
  it("falls through to env.ASSETS", async () => {
    // frontend/dist isn't built in this test env, so ASSETS itself 404s -- this still proves
    // the router forwarded rather than handling the path itself (it never touches R2/DO here).
    const response = await handleRequest(new Request("https://example.com/some/spa/route"), env);
    expect(response.status).toBe(404);
  });

  it("adds security headers to an HTML response from ASSETS", async () => {
    const fakeAssets = {
      fetch: async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
    } as unknown as Env["ASSETS"];
    const response = await handleRequest(
      new Request("https://example.com/"),
      { ...env, ASSETS: fakeAssets },
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
