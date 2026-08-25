# e2e

End-to-end smoke test for the whole stack, per `spec.md` §6.3 (issue #23). A standalone
TypeScript script -- not a vitest suite, no test framework -- that drives the real HTTP/WS
API from the outside and asserts the observable behavior documented in
[`/docs/api.md`](../docs/api.md).

## Running it

```sh
cd e2e
npm install
npm run smoke -- http://localhost:8787
# or against a deployment:
npm run smoke -- https://taxsea-online.<subdomain>.workers.dev
```

(`npm run smoke --` forwards args after `--` to `tsx smoke.ts`; `npx tsx smoke.ts <url>`
works identically if you'd rather skip the npm wrapper.)

The base URL is the only required argument -- nothing in the script is hardcoded to an
environment. Against `wrangler dev` (see [`../docs/development.md`](../docs/development.md)
for getting that running), start `edge`'s dev server first; against a deployment, any
reachable `*.workers.dev` or custom domain works.

Prints one `[PASS]`/`[FAIL]`/`[SKIP]` line per scenario as it finishes, then a summary
count, and exits non-zero if any scenario hard-failed (skips don't count as failures).

## What it covers

| Scenario | What it proves |
|---|---|
| A | Enrichment happy path: submit, watch `running` -> `completed` over the WebSocket, fetch and shape-check the result. |
| B | Same, in `ora` mode. |
| C | Three fast, pre-container-boot 400s: 5001 taxa, a taxon name containing `../`, a malformed `jobId` in a path. |
| D | The SPA's polling fallback -- completes a job using only `GET /state`, no WebSocket. |
| E | A job that reaches `status: "failed"` with a sanitized, non-empty error. |
| F | The timeout path (`status: "timed_out"`). **Skipped by default** -- see below. |
| G | `GET /api/health` returns 200 containing `"Healthy"`. |
| H | Prints (doesn't assert on) submission-to-`completed` wall time from scenario A's cold container -- the number most useful for tuning `instance_type`/`sleepAfter`/`JOB_TIMEOUT_MS`. |

Each container is a fresh boot (no warm pool -- `docs/development.md`), so a full run
against a real deployment takes **roughly 1-3 minutes**: scenarios A, B, D, and E each pay
their own cold-start cost (tens of seconds is normal, not a hang), while C and G are
sub-second.

### How scenario E actually triggers a failure

TaxSEA is deliberately graceful about unmatched input -- both `taxsea_prepare()` and
`taxsea_ORA()` (see [feargalr/TaxSEA](https://github.com/feargalr/TaxSEA)) degrade to a
*warning* plus an empty-but-valid result set when nothing matches, not an R error, and
every mode-mismatch `stop()` inside `TaxSEA()` itself is unreachable through this API
(the edge always sends exactly one of `ranks`/`taxa`, matching `mode`). The one reliably
reachable hard failure: in ORA mode, `background_taxa` (the Fisher's-test "universe") is
computed *after* filtering the bundled taxon-set database down to sets whose size falls in
`[minSetSize, maxSetSize]`. The script pins that window to `[999, 1000]` -- both legal
values per `docs/api.md` §5's clamp to `[2, 1000]` -- and since TaxSEA's curated sets run
from a handful to a few hundred members each, that band matches zero sets, `background_taxa`
ends up empty, and `taxsea_ORA()` hits `stop("ORA: universe is empty.")`. `worker.R`'s
`tryCatch` turns that into a non-zero `Rscript` exit, `main.py` turns *that* into a
job-level `{status:"failed"}` response (`docs/api.md` §2), and the DO relays it to the
client as `JobState.status === "failed"`. If TaxSEA's bundled database ever grows a set
in that size band, this scenario will start failing with `status: "completed"` instead --
widen the window in `scenarioE()` in `smoke.ts` if that happens.

### Scenario F: inducing a real timeout

`JOB_TIMEOUT_MS` is a `wrangler.toml` `[vars]` value, not a per-request parameter, so this
can't be triggered against a normal deployment without a config change. To exercise it for
real:

1. On a **non-production** environment (a separate Cloudflare account/Worker name, or a
   throwaway deploy -- never edit and deploy this against the real production URL), edit
   `edge/wrangler.toml` and drop `JOB_TIMEOUT_MS` to something shorter than a cold container
   boot, e.g. `5000` (5s). A real boot is "tens of seconds" per `docs/development.md`, so a
   5s timeout will fire the alarm well before the container even finishes starting.
2. `wrangler deploy` that environment.
3. Run this script against it with the timeout scenario enabled and a wait window generous
   enough to observe the alarm:

   ```sh
   npm run smoke -- https://<that-environment>.workers.dev \
     --enable-timeout-scenario --timeout-wait-ms=30000
   ```

4. Revert the `wrangler.toml` edit (or just discard the throwaway environment) --
   `JOB_TIMEOUT_MS: 5000` is not a value to leave anywhere near production.

Without `--enable-timeout-scenario`, scenario F always prints `[SKIP]` with a message
pointing back here -- it is never silently dropped from the scenario list, per the
acceptance criteria on issue #23.

## What it doesn't do

- Doesn't run in CI. Per issue #23, wiring this into a scheduled workflow is explicitly
  out of scope for v1 -- run it manually.
- Doesn't assert anything about scenario H's timing number, by design -- it's a
  measurement for future tuning, not a pass/fail gate.
- Scenario C can't directly observe "no container was booted" from an HTTP client; it
  only asserts the 400 status and prints the response latency, which should be
  single-digit milliseconds if edge validation really did reject the request before
  reaching `JobCoordinatorDO.handleDispatch`'s `containerFetch` call.
