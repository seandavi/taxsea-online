# TaxSEA-online — Implementation Plan

Companion to [`spec.md`](./spec.md). Records the architecture review, the deviations from the
spec's code skeletons and why, the repo layout, and the full milestone/issue breakdown. The
same breakdown exists as machine-readable JSON for issue creation.

**Repo name:** `taxsea-online` — accurate, searchable, and doesn't collide with the
Bioconductor package.

**Scope:** 7 milestones, 23 issues. Each issue is sized for one implementer, one branch,
one PR.

**Compute platform:** Cloudflare Containers, bound directly to the job coordinator Durable
Object. Everything on the Cloudflare side — Worker, Durable Object, container image, R2
bindings, SPA assets — ships in a single `wrangler deploy`. No second cloud, no external
registry, no cross-cloud credential.

---

## 1. Architecture review

The async job-coordinator shape in `spec.md` is sound, and Durable Objects are genuinely the
right primitive: per-job state, timeout alarms, and WebSocket fan-out in one object with no
external queue or database. Binding the compute container to that same object removes most
of the remaining machinery (see §2).

The code skeletons contain several defects that would fail in production or expose the
service. Grouped by severity below.

### 1.1 Must fix — the spec is factually wrong about TaxSEA

Verified against the TaxSEA 1.4.0 reference manual (Bioconductor 3.23, published
2026-08-23).

**The base image cannot work.** `spec.md` §4.1 pins `rocker/r-ver:4.3.2`. TaxSEA 1.4.0
declares `Depends: R (>= 4.5.0)`, so the install fails at build time. Use
`bioconductor/bioconductor_docker:RELEASE_3_23`.

**The output contract is invented.** `spec.md` §3.3 specifies result keys
`Metabolite_producers` / `Health_associations` / `BugSigDB` and columns `median_rank`,
`pValue`, `taxaInSet`. The real function returns a named list of data frames whose names
come from the bundled database (the package's own example uses `res$All_databases`), with
columns `taxonSetName`, `median_rank_of_set_members`, `PValue`, `Test_statistic`, `FDR`.
There is no `taxaInSet` column at all.

The fix isn't to substitute a different hardcoded list. Collection names and columns vary by
mode and can change across Bioconductor releases, so the envelope carries them as data:

```json
"results": {
  "<whatever TaxSEA returned>": {
    "columns": ["taxonSetName", "median_rank_of_set_members", "PValue", "Test_statistic", "FDR"],
    "rows": [ { "...": "..." } ]
  }
}
```

The frontend iterates `Object.entries(results)` and renders columns in the given order. A
new column in a future TaxSEA release renders automatically instead of breaking the page.

**`digits = 6` destroys the results.** `spec.md` §4.2 calls
`jsonlite::write_json(results, output_path, auto_unbox = TRUE, digits = 6)`, which rounds to
six decimal places — so every p-value and FDR below `1e-6` serializes as `0`, silently
deleting precisely the findings users came for. Use `digits = NA` and test that `1e-12`
survives the round trip.

**`lookup_missing` must stay off.** The TaxSEA API can fetch missing NCBI IDs from the
Entrez API at runtime. On a public endpoint that would let anyone make our container hammer
NCBI with thousands of lookups. Hardcoded `FALSE`, not user-settable. `custom_db` is
excluded for the same class of reason.

### 1.2 Must fix — security

**R2 key path traversal via `jobId`.** In `spec.md` §4.4 `handleDispatch` takes `jobId` from
the client payload and interpolates it into `jobs/${jobId}/input.json`. A `jobId` of
`../../evil` writes outside the prefix. Fixed at three layers: the router mints the `jobId`
with `crypto.randomUUID()` and ignores any client value; the DO re-validates against a
UUIDv4 regex; the container rejects any key that isn't exactly `jobs/{jobId}/input.json`.
Each check is one line, so defence in depth is free here.

**No input validation anywhere in the spec.** The edge now enforces: body ≤ 1 MiB, 1–5000
taxa, taxon names matching `^[A-Za-z0-9_. -]{1,200}$`, finite numeric ranks (rejecting
`NaN`/`Infinity`/strings), `minSetSize`/`maxSetSize` clamped, unknown keys rejected. This
matters more with per-job containers than it would have with a shared service: an accepted
request boots a multi-GB image, so rejection has to be cheap and has to happen at the edge.

**No rate limiting on an endpoint that spends money.** Cloudflare's native rate-limiting
binding keyed on `CF-Connecting-IP` for `POST /api/jobs` only — reads stay unlimited so a
legitimate page can poll. The real hard ceiling is `max_instances` on the container config.

**WebSocket upgrades bypass CORS entirely.** Any origin can open a socket to a known
`jobId`. The upgrade path checks `Origin` against the Worker's own origin.

**Unsanitized R stderr returned to the client.** R error messages can echo input content.
Truncated to 2000 characters with absolute paths stripped.

**Static shared secret compared with `!=`.** Retained only as a defense-in-depth check on
the container's `/run`, now in an `Authorization` header (not the request body as in §4.3)
and compared with `hmac.compare_digest`. Its blast radius is small because the port is not
internet-reachable at all.

### 1.3 Must fix — correctness

**In-memory WebSocket sessions are lost on eviction.** `spec.md` §4.4 holds sockets in
`this.sessions = new Set()`. A DO can be evicted while the container is still working; on
revival the set is empty and connected clients never hear that their job finished. Fixed
with the **WebSocket Hibernation API** (`ctx.acceptWebSocket` / `ctx.getWebSockets`), which
also stops billing for wall-clock time spent idly holding sockets.

**Fire-and-forget dispatch can vanish.** The un-awaited `fetch(...)` in `handleDispatch` may
not settle before the DO is evicted. The container call now runs inside `ctx.waitUntil(...)`
so the runtime keeps the object alive, with the alarm as a backstop.

**120 s timeout is too tight.** Each job gets a fresh container, so each job pays a cold
start for a multi-GB image. Default raised to 300 s.

**No timeout on the R subprocess.** A pathological input hangs the container until the
platform kills it. `subprocess.run(timeout=...)`, reported as a distinct failure mode.

**Job failure vs. request failure were conflated.** The container returns HTTP 200 with
`status: "failed"` when R errored (the request succeeded, the analysis didn't) and reserves
non-2xx for malformed requests, so the DO can tell an infrastructure problem from a bad
input.

### 1.4 Deliberately deferred

Not fortress-building a v1. Out of scope, with the trigger for revisiting:

| Deferred | Add when |
|---|---|
| Turnstile / CAPTCHA on submission | IP rate limiting proves insufficient against real abuse |
| Container pooling (warm instances) | Cold-start latency measured in M7 proves unacceptable |
| User accounts, job history | Anyone asks to retrieve a job older than the 7-day lifecycle |
| GCP uptime checks wired to `/health` | Post-launch — the endpoint exists so this is config, not code |
| Result caching by input hash | Repeat submissions show up in the logs as a real cost |
| Scheduled E2E runs in CI | After the manual E2E script has been stable a while |

---

## 2. Design decisions that deviate from the spec

### 2.1 Cloudflare Containers, not an external container platform

`spec.md` §1 proposes Cloud Run / Fly.io / ECS. Using Cloudflare Containers instead collapses
a large amount of the design:

`Container` (from `@cloudflare/containers`) **extends `DurableObject`**, so `JobCoordinatorDO`
is simultaneously the job coordinator and the container-backed class — one `class_name`
appears in both `[[containers]]` and `[[durable_objects.bindings]]`. The DO reaches its
container with `this.containerFetch(...)` on a private port.

What that removes outright:

| Removed | Why it's gone |
|---|---|
| The webhook callback (`spec.md` §2 steps 9–11) | The DO calls the container and awaits the response |
| Per-job callback tokens, callback auth | Nothing calls back |
| `callbackUrl` SSRF host allowlist | No callback URL exists |
| `COMPUTE_WORKER_URL` | The container is a binding, not a URL |
| FastAPI `BackgroundTasks` + callback retry logic | `/run` is now synchronous; ~40 lines of Python total |
| A container registry (Artifact Registry / GHCR / ECR) | `wrangler deploy` builds the Dockerfile and pushes to Cloudflare's managed registry |
| A second deploy pipeline, and GCP deploy identity entirely | One `wrangler deploy` ships everything |
| `--no-cpu-throttling`-class platform footguns | No request-scoped CPU throttling to work around |
| boto3, an S3 client, and every storage credential | The DO has a native R2 binding and does all storage I/O — see §2.6 |

`instance_type` defaults to `standard-1` (0.5 vCPU / 4 GiB memory / 8 GB disk), which fits a
1–3 GB Bioconductor image comfortably; tiers go to `standard-4` (20 GB disk) and custom
`{vcpu, memory_mib, disk_mb}` is also available. `max_instances` is the hard ceiling on
concurrent jobs and therefore the primary spend control.

**Prerequisite:** Cloudflare Containers requires the Workers Paid plan. **Already satisfied
on this account** — not an open blocker.

**Accepted trade-off:** one container per DO id means one container per job, so every job
pays a cold start. That's why the timeout is 300 s and why M7 measures cold-start latency
explicitly rather than asserting on it. If it hurts, the upgrade path is a small pool of
container ids keyed by slot instead of by jobId, at the cost of needing concurrency control
inside the pool.

### 2.2 One Worker serves both the SPA and the API

`spec.md` implies separate frontend hosting and an `api.yourdomain.com`. Workers static
assets in the same Worker makes everything same-origin, which removes the need for CORS
entirely, makes deploys atomic (frontend and API always ship together), and means the SPA
has no hardcoded API domain.

### 2.3 Results are proxied through the Worker, not fetched from a public R2 bucket

`spec.md` §5 fetches `https://data.yourdomain.com/${outputKey}`, requiring a publicly
readable bucket and exposing the R2 key layout to the client. Instead,
`GET /api/jobs/:jobId/result` streams from the R2 binding: the bucket stays private, no
second domain, no presigned-URL signing code, no CORS. `outputKey` disappears from the
client-facing `JobState`. Outputs are small JSON, so Worker egress is negligible.

### 2.4 The health endpoint does not probe the container

Both tiers expose a health endpoint per org convention (200 with a body containing the
literal `Healthy`, else 503). But `GET /api/health` on the edge deliberately checks only R2
and a DO round-trip — **probing the container would pull and boot a multi-GB image on every
probe**, costing more than the service itself and defeating scale-to-zero. The container's
own `/health` still exists and is wired to the container class's `pingEndpoint` as a
readiness probe. This is called out inline in the code so nobody "fixes" it later.

### 2.5 No dependencies beyond the essentials

No monorepo tool, no UI component library, no CSS framework, no state management library, no
logging framework, no `moto`. The frontend is a form, a progress indicator, and a table;
`console.log(JSON.stringify(...))` is a structured logger.

### 2.6 The container has no storage access and no network — the DO does all R2 I/O

**Decided.** Payloads cross the DO↔container boundary **by value**: the DO passes the
validated submission in the `containerFetch` body, and the container returns the complete
`output.json` envelope in the response body. The DO writes both `input.json` and
`output.json` to R2 through its native binding.

`spec.md` §4.3 instead gives the container a boto3 S3 client and R2 credentials. Dropping
that removes, from the container: boto3, the S3 client, four environment variables, and two
credentials — and lets it run with **`enableInternet = false`**. The process executing
user-supplied input through R therefore has zero network egress and holds nothing but one
shared secret. That is the strongest security property in this design, and it comes from
deleting code rather than adding it.

Input is capped at 1 MiB and TaxSEA outputs are small, so request/response body size is not
a constraint.

**Accepted cost:** if the DO is evicted mid-job, the in-flight result is lost — the container
has nowhere to persist it, so the alarm fires and the job reports `timed_out` and the client
resubmits. Recovery-by-scanning-R2 is explicitly **not** built for v1. The DO carries a
`// ponytail:` comment naming this ceiling so it reads as a decision rather than an
oversight.

The one invariant this creates: on completion the DO must write `output.json` to R2
**before** flipping job state to `completed`, so a client that sees `completed` can always
fetch a result. That ordering is an acceptance criterion on the DO issue.

---

## 3. Repo layout

```
taxsea-online/
├── worker/                 R + FastAPI container image source
│   ├── Dockerfile          bioconductor/bioconductor_docker:RELEASE_3_23, linux/amd64
│   ├── main.py             synchronous POST /run, GET /health — no SDK, no credentials
│   ├── worker.R            Rscript entrypoint
│   ├── requirements.txt    fully pinned
│   └── tests/              pytest + fixtures + test_worker_r.R
├── edge/                   the entire Cloudflare deployment
│   ├── wrangler.toml       [[containers]] + DO + R2 + rate limiter + assets
│   ├── src/
│   │   ├── index.ts        router, validation, rate limiting, result proxy
│   │   ├── JobCoordinatorDO.ts   extends Container (which extends DurableObject)
│   │   ├── schema.ts
│   │   └── log.ts
│   └── test/
├── frontend/               React SPA (Vite), builds to dist/, served by edge
│   └── src/{components,hooks,lib}
├── e2e/                    smoke test (spec §6.3)
├── docs/
│   ├── api.md              frozen contracts — single source of truth
│   ├── infra.md            secrets, R2, runbooks
│   └── development.md      local dev for all three components
└── .github/workflows/
    ├── ci-js.yml           PR: edge + frontend, no secrets
    ├── ci-worker.yml       PR: python/R + docker build, no secrets
    └── deploy.yml          push:main + dispatch, one wrangler deploy
```

`/worker` holds only the image source. The container is *declared and deployed* from
`/edge/wrangler.toml`.

**CI/CD safety.** The two `ci-*.yml` workflows reference no secret at all, so fork PRs run
the full suite and pass. `deploy.yml` triggers only on `push: main` and `workflow_dispatch` —
`pull_request` appears nowhere in it, which is what structurally guarantees a fork PR can
never reach credentials.

---

## 4. Contracts

Frozen in `/docs/api.md` in M1, before any implementation starts.

```
POST   /api/jobs                    -> 201 { jobId, status, wsUrl, stateUrl, resultUrl }
GET    /api/jobs/:jobId/state       -> 200 JobState | 404
GET    /api/jobs/:jobId/ws          -> 101 WebSocket, server pushes JobState
GET    /api/jobs/:jobId/result      -> 200 output.json (proxied from R2)
GET    /api/health                  -> 200 "Healthy" | 503
```

There is no `/callback` route.

Internal, DO → container, via `containerFetch` on a private port:

```
POST http://localhost:8080/run
  Authorization: Bearer <WORKER_SHARED_SECRET>
  { jobId, mode, ranks|taxa, options }
  -> 200 { jobId, status: "completed", executionTimeMs, taxsea: {...}, results: {...} }
  -> 200 { jobId, status: "failed", executionTimeMs, error }
```

Synchronous: it returns only when the R run has finished. The success body **is** the
`output.json` envelope, which the DO writes to R2 unchanged. No storage keys cross this
boundary, so there are no keys for the container to validate.

`JobState` is the only object pushed over the WebSocket, and deliberately contains no
`outputKey` and no token.

---

## 5. Secrets

Scope is `taxsea`, convention `<scope>-<subject>-<credential-type>[-<qualifier>]`, all in GCP
Secret Manager project `cdsci-infra`. Secret Manager is used purely as the credential
**store** — there is no GCP compute and no GCP deploy identity in this architecture.

**Reused, do not recreate:**

| Secret | Used for |
|---|---|
| `cdsci-cloudflare-api-token` / `cdsci-cloudflare-workers-token` | `wrangler deploy` from GitHub Actions |

**No R2 credentials are needed by this project at all** — the Worker and DO use the native
binding and the container has no storage access (§2.6), so the `cdsci-r2-*` secrets are
unused here.

**New — one secret, and it is the only credential the application code handles:**

| Name | Purpose | Consumed by |
|---|---|---|
| `taxsea-worker-shared-secret-service-token` | Internal DO → container `POST /run` check | Worker secret `WORKER_SHARED_SECRET`, forwarded to the container via the container class's `envVars` |

**Likely first-deploy blocker to verify early:** the Cloudflare API token needs permission to
build and push a container image to Cloudflare's managed registry, on top of Workers Scripts
edit, Durable Objects, and R2. If `cdsci-cloudflare-workers-token` lacks container/registry
scope, that surfaces at the first `wrangler deploy`. The infra issue makes checking this an
explicit acceptance criterion.

---

## 6. Milestones and issues

Ordered so dependencies come first. M2, M3 and M4 can proceed in parallel once M1 lands,
since `/docs/api.md` decouples them.

### M1: Foundations (2 issues)

1. **Scaffold the monorepo layout and shared tooling** — `infra`, `docs`
2. **Freeze the public API and data contracts in `/docs/api.md`** — `docs`, `edge`

Issue 2 is the keystone: it corrects the TaxSEA output contract, pins the input limits, and
commits shared fixtures. Nothing else should start until it merges.

### M2: R compute container image (5 issues)

3. **Build the R/TaxSEA container image** — `worker`, `infra`
4. **Implement `worker.R`: enrichment and ORA with a stable JSON envelope** — `worker`
5. **Implement the FastAPI wrapper: synchronous `/run`, payloads by value** — `worker`
6. **Add the `/health` endpoint to the container** — `worker`
7. **Test suite for the container** — `worker`, `ci`

Issue 3 must record the final image size — it determines the required `instance_type` disk
and drives cold-start time.

### M3: Cloudflare edge (5 issues)

8. **Scaffold the edge Worker: `wrangler.toml` with container, DO, R2 and assets bindings** — `edge`, `infra`
9. **Implement `JobCoordinatorDO`: container dispatch, state machine, timeout alarm** — `edge`
10. **WebSocket progress channel using the Hibernation API** — `edge`
11. **Public API router: input validation, jobId minting, rate limiting, result proxy** — `edge`
12. **Add `GET /api/health` to the edge Worker** — `edge`

Issues 10 and 11 both depend on 9 but not on each other, so they can run in parallel. Issue 9
carries the subtlest requirement in the project: the DO's `fetch` override must route
`/state` and `/ws` **without** calling `containerFetch`, or every status poll boots a
multi-GB container.

### M4: React frontend (4 issues)

13. **Scaffold the React SPA and serve it from the edge Worker** — `frontend`
14. **Job submission form with client-side parsing and validation** — `frontend`
15. **`useTaxSEAJob` hook: WebSocket progress with a polling fallback** — `frontend`
16. **Results view: dynamic tables, sorting, and downloads** — `frontend`

Issue 14 is where most real-world usability lives: users arrive with a two-column table
pasted from a spreadsheet, not hand-written JSON.

### M5: Continuous integration (2 issues)

17. **PR workflow: lint, typecheck and test the edge Worker and frontend** — `ci`
18. **PR workflow: lint and test the container, and verify the image builds** — `ci`, `worker`

Split by toolchain because the image build is slow and path-filtered independently. Issue 18
matters more than usual: `wrangler deploy` builds the image at deploy time, so without a PR
build a broken Dockerfile would only surface in production.

### M6: Infrastructure and deployment (2 issues)

19. **Provision the R2 bucket, lifecycle rules, and GCP Secret Manager entries** — `infra`, `docs`
20. **Deploy workflow: single `wrangler deploy` for Worker, DO, container and SPA** — `ci`, `infra`

Small for an infrastructure milestone because Cloudflare Containers removes what would
otherwise live here: no registry to provision, no separate container deploy pipeline, no
second-cloud deploy identity.

### M7: Documentation, verification and launch (3 issues)

21. **README and local development guide for all three components** — `docs`
22. **Structured logging and `jobId` correlation** — `edge`, `worker`
23. **End-to-end smoke test (spec §6.3)** — `ci`, `edge`, `worker`

Issue 23 covers all five checks in spec §6.3 plus the ORA path, polling fallback, validation
rejections, health, the alarm's R2-recovery behavior, and a recorded cold-start budget —
eight scenarios, each pass/fail.

---

## 7. Risks

**Cold start on every job.** One container per DO id means no warm reuse. A multi-GB
Bioconductor image plus R startup could plausibly reach tens of seconds before analysis even
begins. Mitigated by a 300 s timeout, a "starting analysis environment" UI state so users
don't read it as a hang, and an explicit measurement in M7. Upgrade path if it hurts: pool
container ids by slot rather than by jobId.

**Cloudflare API token scope.** The most likely first-deploy blocker — container image push
may need permissions the existing token lacks. Checked explicitly in M6.

**Taxon name matching.** With `lookup_missing = FALSE`, names not in TaxSEA's bundled
`NCBI_ids` mapping are silently dropped and the user sees empty results with no explanation.
Most likely support burden. Mitigated by documentation and the "Load example data" button;
if it becomes real, surface an "N of M taxa matched" count in the results view.

**Cost of a public compute endpoint.** Three layers: IP rate limiting at the edge,
`max_instances` as the hard ceiling on concurrent containers, and short `sleepAfter` so
nothing idles. Turnstile is the next lever if those prove insufficient.
