#!/usr/bin/env -S npx tsx
/**
 * End-to-end smoke test for the whole TaxSEA-online stack (issue #23, spec.md §6.3).
 *
 * Runs against a base URL -- `wrangler dev` (http://localhost:8787) or a deployed
 * *.workers.dev / custom domain. Nothing here is hardcoded to an environment.
 *
 *   tsx smoke.ts http://localhost:8787
 *   tsx smoke.ts https://taxsea-online.<subdomain>.workers.dev
 *
 * Every request/response shape asserted below comes from /docs/api.md, which is the
 * frozen contract -- see that file for the authoritative JobState and output.json shapes.
 *
 * Scenario F (timeout) needs a temporarily-reduced JOB_TIMEOUT_MS that isn't
 * runtime-configurable per request. It is SKIPPED unless explicitly enabled -- see
 * README.md for how to induce it manually and the flags below.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Contract types (docs/api.md §3, §8) -- kept local to this script on purpose;
// /e2e has no build relationship with /edge and shouldn't import its internals.
// ---------------------------------------------------------------------------

type JobStatus = "queued" | "running" | "completed" | "failed" | "timed_out";

interface JobState {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  executionTimeMs: number | null;
  error: string | null;
}

interface CreateJobResponse {
  jobId: string;
  status: string;
  wsUrl: string;
  stateUrl: string;
  resultUrl: string;
}

interface ResultCollection {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface OutputEnvelope {
  jobId: string;
  status: "completed";
  executionTimeMs: number;
  taxsea: { packageVersion: string; mode: string; params: Record<string, unknown> };
  results: Record<string, ResultCollection>;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "timed_out"]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class AssertionFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailure(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
function readFixture(name: string): unknown {
  const p = path.join(HERE, "..", "worker", "tests", "fixtures", name);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function postJob(baseUrl: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

function toWsUrl(baseUrl: string, wsPath: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = wsPath;
  u.search = "";
  return u.toString();
}

/**
 * Opens the job's WebSocket and resolves with every JobState frame observed, once a
 * terminal one arrives. Sets `Origin` to the target's own origin -- the DO's /ws upgrade
 * validates Origin (docs/api.md §6) and Node's standard WebSocket API has no way to set
 * that header itself, hence the `ws` package instead of the global WebSocket here.
 */
function waitForTerminalViaWs(
  baseUrl: string,
  wsPath: string,
  timeoutMs: number,
): Promise<{ states: JobState[]; final: JobState }> {
  return new Promise((resolve, reject) => {
    const origin = new URL(baseUrl).origin;
    const ws = new WebSocket(toWsUrl(baseUrl, wsPath), { headers: { Origin: origin } });
    const states: JobState[] = [];

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a terminal state over WS`));
    }, timeoutMs);

    ws.on("message", (data) => {
      let state: JobState;
      try {
        state = JSON.parse(data.toString());
      } catch {
        return; // not a JobState frame -- ignore
      }
      states.push(state);
      if (TERMINAL.has(state.status)) {
        clearTimeout(timer);
        ws.close();
        resolve({ states, final: state });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Scenario D's whole point: reach a terminal state using only GET /state, no WS. */
async function pollUntilTerminal(
  baseUrl: string,
  jobId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<JobState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}/state`);
    assert(res.status === 200, `GET /state returned ${res.status}, expected 200`);
    const state = (await res.json()) as JobState;
    if (TERMINAL.has(state.status)) return state;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms polling /state (last status: ${state.status})`);
    }
    await sleep(intervalMs);
  }
}

async function fetchResult(baseUrl: string, resultUrl: string): Promise<OutputEnvelope> {
  const res = await fetch(`${baseUrl}${resultUrl}`);
  assert(res.status === 200, `GET ${resultUrl} returned ${res.status}, expected 200`);
  return (await res.json()) as OutputEnvelope;
}

/** docs/api.md §8: results non-empty, every collection has columns+rows, at least one row
 * has a numeric FDR somewhere in the envelope. */
function assertEnvelopeShape(envelope: OutputEnvelope): void {
  assert(envelope.status === "completed", `envelope.status was "${envelope.status}", expected "completed"`);
  assert(
    envelope.results && typeof envelope.results === "object" && Object.keys(envelope.results).length > 0,
    "results must be a non-empty object",
  );
  let sawNumericFdr = false;
  for (const [name, collection] of Object.entries(envelope.results)) {
    assert(Array.isArray(collection.columns), `collection "${name}" is missing a columns array`);
    assert(Array.isArray(collection.rows), `collection "${name}" is missing a rows array`);
    for (const row of collection.rows) {
      if (typeof row.FDR === "number" && Number.isFinite(row.FDR)) sawNumericFdr = true;
    }
  }
  assert(sawNumericFdr, "no row across any collection had a numeric FDR value");
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

type ScenarioOutcome = "pass" | "fail" | "skip";
interface ScenarioResult {
  name: string;
  outcome: ScenarioOutcome;
  detail: string;
}

/** Shared between scenarios -- H reports timing captured during A rather than paying for
 * a third cold container boot just to print a number. */
interface Ctx {
  baseUrl: string;
  coldStartMsA: number | null;
  enableTimeoutScenario: boolean;
  timeoutScenarioWaitMs: number;
}

async function runScenario(
  name: string,
  fn: () => Promise<{ outcome: ScenarioOutcome; detail: string }>,
): Promise<ScenarioResult> {
  try {
    const { outcome, detail } = await fn();
    return { name, outcome, detail };
  } catch (err) {
    return { name, outcome: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

function printResult(r: ScenarioResult): void {
  const label = r.outcome.toUpperCase().padEnd(4);
  console.log(`[${label}] ${r.name} -- ${r.detail}`);
}

// ---------------------------------------------------------------------------
// Scenarios A/B: enrichment / ORA happy path
// ---------------------------------------------------------------------------

async function happyPath(
  ctx: Ctx,
  mode: "enrichment" | "ora",
  fixtureFile: string,
): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  const body = readFixture(fixtureFile);
  const t0 = Date.now();

  const created = await postJob(ctx.baseUrl, body);
  assert(created.status === 201, `POST /api/jobs returned ${created.status}, expected 201: ${JSON.stringify(created.json)}`);
  const job = created.json as CreateJobResponse;
  assert(typeof job.jobId === "string" && job.jobId.length > 0, "response missing jobId");

  const { states, final } = await waitForTerminalViaWs(ctx.baseUrl, job.wsUrl, 320_000);
  const elapsedMs = Date.now() - t0;

  // Cold boot realistically takes seconds-to-tens-of-seconds (docs/development.md), so the
  // very first pushed frame is virtually always "running" -- see JobCoordinatorDO.handleDispatch,
  // which persists status "running" synchronously before the container call even starts.
  const sawRunning = states.some((s) => s.status === "running");
  assert(sawRunning, `never observed a "running" state before terminal (states: ${states.map((s) => s.status).join(",")})`);
  assert(final.status === "completed", `job reached terminal status "${final.status}", expected "completed" (error: ${final.error})`);

  const envelope = await fetchResult(ctx.baseUrl, job.resultUrl);
  assertEnvelopeShape(envelope);

  // Scenario H reports this rather than paying for a third cold container boot just to
  // print a number -- see the Ctx doc comment.
  if (mode === "enrichment") ctx.coldStartMsA = elapsedMs;

  return {
    outcome: "pass",
    detail: `${mode}: completed in ${elapsedMs}ms, ${Object.keys(envelope.results).length} result collection(s)`,
  };
}

// ---------------------------------------------------------------------------
// Scenario C: validation rejection -- all three checks must reject fast, before any
// container boots. The lack of a container boot isn't directly observable from an HTTP
// client; the DO only calls containerFetch from handleDispatch, which none of these three
// requests ever reach (edge validation / jobId regex reject them first -- see
// edge/src/schema.ts and edge/src/index.ts's JOB_ID_RE check).
// ---------------------------------------------------------------------------

async function scenarioC(ctx: Ctx): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  const failures: string[] = [];

  // 5001 taxa -- one over MAX_TAXA (docs/api.md §5).
  const tooManyTaxa = Array.from({ length: 5001 }, (_, i) => `Synthetic_taxon_${i}`);
  const t1 = Date.now();
  const overLimit = await postJob(ctx.baseUrl, { mode: "ora", taxa: tooManyTaxa });
  const overLimitMs = Date.now() - t1;
  if (overLimit.status !== 400) failures.push(`5001 taxa: expected 400, got ${overLimit.status}`);

  // A taxon name containing "../" -- rejected by the name regex (no "/" allowed at all).
  const t2 = Date.now();
  const pathTraversalName = await postJob(ctx.baseUrl, { mode: "ora", taxa: ["../etc/passwd"] });
  const pathTraversalMs = Date.now() - t2;
  if (pathTraversalName.status !== 400) {
    failures.push(`"../" taxon name: expected 400, got ${pathTraversalName.status}`);
  }

  // Malformed jobId in a path.
  const t3 = Date.now();
  const badJobIdRes = await fetch(`${ctx.baseUrl}/api/jobs/not-a-valid-uuid/state`);
  const badJobIdMs = Date.now() - t3;
  if (badJobIdRes.status !== 400) failures.push(`malformed jobId: expected 400, got ${badJobIdRes.status}`);

  const timings = `latencies: 5001-taxa=${overLimitMs}ms, "../"=${pathTraversalMs}ms, badJobId=${badJobIdMs}ms`;
  if (failures.length > 0) {
    return { outcome: "fail", detail: `${failures.join("; ")} (${timings})` };
  }
  return { outcome: "pass", detail: `all three rejected with 400 (${timings})` };
}

// ---------------------------------------------------------------------------
// Scenario D: polling-only fallback -- never opens a WS.
// ---------------------------------------------------------------------------

async function scenarioD(ctx: Ctx): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  const body = readFixture("ora_input.json");
  const created = await postJob(ctx.baseUrl, body);
  assert(created.status === 201, `POST /api/jobs returned ${created.status}, expected 201`);
  const job = created.json as CreateJobResponse;

  const final = await pollUntilTerminal(ctx.baseUrl, job.jobId, 3_000, 320_000);
  assert(final.status === "completed", `job reached terminal status "${final.status}", expected "completed" (error: ${final.error})`);

  const envelope = await fetchResult(ctx.baseUrl, job.resultUrl);
  assertEnvelopeShape(envelope);

  return { outcome: "pass", detail: `completed via /state polling only, ${Object.keys(envelope.results).length} result collection(s)` };
}

// ---------------------------------------------------------------------------
// Scenario E: failure path.
//
// TaxSEA itself is deliberately graceful about unmatched taxa/ranks -- taxsea_prepare()
// and taxsea_ORA() (feargalr/TaxSEA) both degrade to a *warning* plus an empty-but-valid
// result set when nothing matches, not an R error, and every mode-mismatch stop() in
// TaxSEA() is unreachable through this API (schema.ts always sends exactly one of
// ranks/taxa, matching mode). The one reliably reachable hard failure: ORA mode's
// background_taxa ("universe") is computed *after* filtering the bundled taxon-set
// database down to sets whose size falls in [minSetSize, maxSetSize]
// (taxsea_prepare.R's ORA path). Pin that window to [999, 1000] -- both legal per
// docs/api.md §5's clamp to [2, 1000] -- and TaxSEA's curated sets (a few to a few
// hundred members each) yield zero sets in that band, so background_taxa ends up empty
// and taxsea_ORA.R hits `stop("ORA: universe is empty.")`. worker.R's tryCatch turns
// that into a non-zero Rscript exit, which main.py turns into a job-level
// {status:"failed"} response (docs/api.md §2), which the DO relays to the client as
// JobState.status === "failed" with a sanitized, non-empty error.
// ---------------------------------------------------------------------------

async function scenarioE(ctx: Ctx): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  const fixture = readFixture("ora_input.json") as { taxa: string[] };
  const body = { mode: "ora", taxa: fixture.taxa, options: { minSetSize: 999, maxSetSize: 1000 } };

  const created = await postJob(ctx.baseUrl, body);
  assert(created.status === 201, `POST /api/jobs returned ${created.status}, expected 201`);
  const job = created.json as CreateJobResponse;

  const { final } = await waitForTerminalViaWs(ctx.baseUrl, job.wsUrl, 320_000);
  assert(
    final.status === "failed",
    `job reached terminal status "${final.status}", expected "failed" -- if TaxSEA's bundled ` +
      `database changed such that a set now has 999-1000 members, widen the minSetSize/maxSetSize ` +
      `gap in this scenario (see comment above)`,
  );
  assert(typeof final.error === "string" && final.error.length > 0, "JobState.error must be a non-empty string");
  assert(final.error.length <= 2000, "JobState.error must be truncated to <= 2000 chars (docs/api.md §6)");

  return { outcome: "pass", detail: `job reached "failed" with error: "${final.error}"` };
}

// ---------------------------------------------------------------------------
// Scenario F: timeout path. Not automatable against a normal deployment -- JOB_TIMEOUT_MS
// is a wrangler.toml [vars] value, not a per-request parameter. See README.md for how to
// induce it manually; this only runs for real when explicitly enabled.
// ---------------------------------------------------------------------------

async function scenarioF(ctx: Ctx): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  if (!ctx.enableTimeoutScenario) {
    return {
      outcome: "skip",
      detail:
        "requires manual JOB_TIMEOUT_MS override -- see README.md, then re-run with --enable-timeout-scenario",
    };
  }

  const body = readFixture("enrichment_input.json");
  const created = await postJob(ctx.baseUrl, body);
  assert(created.status === 201, `POST /api/jobs returned ${created.status}, expected 201`);
  const job = created.json as CreateJobResponse;

  const { final } = await waitForTerminalViaWs(ctx.baseUrl, job.wsUrl, ctx.timeoutScenarioWaitMs);
  assert(
    final.status === "timed_out",
    `job reached terminal status "${final.status}", expected "timed_out" (error: ${final.error})`,
  );
  assert(typeof final.error === "string" && final.error.length > 0, "JobState.error must be a non-empty string");

  return { outcome: "pass", detail: `job reached "timed_out" with error: "${final.error}"` };
}

// ---------------------------------------------------------------------------
// Scenario G: health.
// ---------------------------------------------------------------------------

async function scenarioG(ctx: Ctx): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  const res = await fetch(`${ctx.baseUrl}/api/health`);
  assert(res.status === 200, `GET /api/health returned ${res.status}, expected 200`);
  const text = await res.text();
  assert(text.includes("Healthy"), `body did not contain "Healthy": ${text}`);
  return { outcome: "pass", detail: text.trim() };
}


// ---------------------------------------------------------------------------
// Scenario I: security headers on the HTML entry point.
//
// Only checkable against a real deployment. edge/test/router.test.ts asserts that the
// Worker *adds* these headers, which is true -- but Cloudflare serves static assets
// before invoking the Worker, so "/" (matching index.html) was served straight from the
// asset layer and never reached withSecurityHeaders() at all (issue #95). A unit test
// can't see that; only a live request can. Checks "/" specifically, not a SPA fallback
// route like /about, because the fallback path always did reach the Worker.
// ---------------------------------------------------------------------------

async function scenarioI(ctx: Ctx): Promise<{ outcome: ScenarioOutcome; detail: string }> {
  // Cache-bust: a cached edge copy can predate a routing change.
  const res = await fetch(`${ctx.baseUrl}/?smoke=${Date.now()}`);
  assert(res.status === 200, `GET / returned ${res.status}, expected 200`);

  const csp = res.headers.get("Content-Security-Policy");
  assert(
    csp !== null,
    'GET / has no Content-Security-Policy -- the Worker is being bypassed for asset-matched ' +
      'paths; check run_worker_first in edge/wrangler.toml (issue #95)',
  );
  assert(
    res.headers.get("X-Content-Type-Options") === "nosniff",
    `X-Content-Type-Options was "${res.headers.get("X-Content-Type-Options")}", expected "nosniff"`,
  );
  assert(
    res.headers.get("Referrer-Policy") === "no-referrer",
    `Referrer-Policy was "${res.headers.get("Referrer-Policy")}", expected "no-referrer"`,
  );
  assert(!/script-src[^;]*unsafe-inline/.test(csp ?? ""), `CSP grants unsafe-inline: ${csp}`);

  return { outcome: "pass", detail: `CSP, nosniff and Referrer-Policy all present on /` };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Ctx {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const baseUrlArg = positional[0];
  if (!baseUrlArg) {
    console.error("Usage: tsx smoke.ts <baseUrl> [--enable-timeout-scenario] [--timeout-wait-ms=60000]");
    process.exit(1);
  }
  const enableTimeoutScenario = argv.includes("--enable-timeout-scenario");
  const waitArg = argv.find((a) => a.startsWith("--timeout-wait-ms="));
  const timeoutScenarioWaitMs = waitArg ? Number(waitArg.split("=")[1]) : 60_000;

  return {
    baseUrl: baseUrlArg.replace(/\/+$/, ""),
    coldStartMsA: null,
    enableTimeoutScenario,
    timeoutScenarioWaitMs,
  };
}

async function main(): Promise<void> {
  const ctx = parseArgs(process.argv.slice(2));
  console.log(`TaxSEA-online E2E smoke test against ${ctx.baseUrl}\n`);

  const results: ScenarioResult[] = [];

  const a = await runScenario("A (enrichment happy path)", () => happyPath(ctx, "enrichment", "enrichment_input.json"));
  results.push(a);
  printResult(a);
  // happyPath() sets ctx.coldStartMsA itself on success (see its doc comment).

  const b = await runScenario("B (ORA happy path)", () => happyPath(ctx, "ora", "ora_input.json"));
  results.push(b);
  printResult(b);

  const c = await runScenario("C (validation rejection)", () => scenarioC(ctx));
  results.push(c);
  printResult(c);

  const d = await runScenario("D (polling-only fallback)", () => scenarioD(ctx));
  results.push(d);
  printResult(d);

  const e = await runScenario("E (failure path)", () => scenarioE(ctx));
  results.push(e);
  printResult(e);

  const f = await runScenario("F (timeout path)", () => scenarioF(ctx));
  results.push(f);
  printResult(f);

  const g = await runScenario("G (health)", () => scenarioG(ctx));
  results.push(g);
  printResult(g);

  const i = await runScenario("I (security headers on /)", () => scenarioI(ctx));
  results.push(i);
  printResult(i);

  const h = await runScenario("H (cold start budget)", async () => {
    if (ctx.coldStartMsA === null) {
      return { outcome: "skip" as const, detail: "scenario A did not complete -- no timing available" };
    }
    return {
      outcome: "pass" as const,
      detail: `submission-to-completed wall time (scenario A, cold container): ${ctx.coldStartMsA}ms -- informational only, no assertion`,
    };
  });
  results.push(h);
  printResult(h);

  const failed = results.filter((r) => r.outcome === "fail");
  const passed = results.filter((r) => r.outcome === "pass").length;
  const skipped = results.filter((r) => r.outcome === "skip").length;

  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped} skipped`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
