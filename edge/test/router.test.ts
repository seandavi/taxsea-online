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

describe("forwardToDO origin preservation", () => {
  it("forwards /state and /ws with the real request origin, not a placeholder", async () => {
    // Regression test: forwardToDO used to rewrite the internal request to
    // `http://do${path}`, so JobCoordinatorDO's own Origin-header check (which reads
    // `new URL(request.url).origin`) could never match a real client's Origin header --
    // every WebSocket connection 403'd in production despite passing every unit test,
    // because tests call handleFetch/handleRequest with a real URL directly, never
    // through this rewrite (found via the real deployed e2e smoke test, issue #23).
    let seenUrl: string | undefined;
    const fakeCoordinator = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          seenUrl = input instanceof Request ? input.url : input.toString();
          return new Response(null, { status: 200 });
        },
      }),
    } as unknown as Env["JOB_COORDINATOR"];

    const jobId = crypto.randomUUID();
    await handleRequest(getJob(jobId, "ws"), { ...env, JOB_COORDINATOR: fakeCoordinator });

    expect(seenUrl).toBeDefined();
    expect(new URL(seenUrl!).origin).toBe("https://example.com");
    expect(new URL(seenUrl!).pathname).toBe("/ws");
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

  it("streams the R2 object with the right Content-Type, and does not allow it to be cached", async () => {
    const jobId = crypto.randomUUID();
    const output = { jobId, status: "completed", executionTimeMs: 1, taxsea: {}, results: {} };
    await env.TAXSEA_BUCKET.put(`jobs/${jobId}/output.json`, JSON.stringify(output));

    const response = await handleRequest(getJob(jobId, "result"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    // issue #68: results may be unpublished research data, and a public year-long cache
    // would outlive the 7-day R2 retention docs/infra.md promises.
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
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
    // issue #68: job status is mutable and per-job -- nothing should retain it.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ jobId, status: "running" });
  });

  it("leaves the /ws upgrade response untouched so the socket survives", async () => {
    // The no-store rewrite above must not apply here: reconstructing the response would
    // drop its `webSocket` and silently break every WebSocket connection (issue #68).
    const jobId = crypto.randomUUID();
    const [client] = Object.values(new WebSocketPair());
    const fakeEnv = envWithFakeCoordinator((path) => {
      expect(path).toBe("/ws");
      return new Response(null, { status: 101, webSocket: client });
    });
    const response = await handleRequest(getJob(jobId, "ws"), fakeEnv);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(client);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});

describe("unmatched routes", () => {
  it("falls through to env.ASSETS", async () => {
    // A fake ASSETS binding, not the real one: whether the real ../frontend/dist has been
    // built (and what env.ASSETS.fetch returns for an unmatched path -- 200 with the SPA
    // shell via `not_found_handling = "single-page-application"`, or 404 if dist is an
    // empty placeholder, as in ci-js.yml's edge job) is unrelated to what this test is
    // checking: that the router forwards unmatched paths to ASSETS at all, rather than
    // handling them itself or touching R2/DO.
    let assetsCalled = false;
    const fakeAssets = {
      fetch: async () => {
        assetsCalled = true;
        return new Response("<html>the spa shell</html>", { headers: { "Content-Type": "text/html" } });
      },
    } as unknown as Env["ASSETS"];

    const response = await handleRequest(
      new Request("https://example.com/some/spa/route"),
      { ...env, ASSETS: fakeAssets },
    );

    expect(assetsCalled).toBe(true);
    expect(response.status).toBe(200);
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
    // The GA4 loader tag in frontend/index.html is dead weight without this host, and it
    // fails silently in the browser console -- pin it so a CSP tightening can't quietly
    // switch analytics off.
    expect(csp).toMatch(/script-src[^;]*https:\/\/www\.googletagmanager\.com/);
  });
});
