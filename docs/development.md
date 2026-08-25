# Local development

How to run each of the three components on its own, and the whole stack together, on a
machine that has never run this project before. See [`docs/api.md`](./api.md) for the
frozen contracts referenced throughout, and [`PLAN.md`](../PLAN.md) for why the architecture
looks like this.

Prerequisites: Node 22, Python 3.11+, a local Docker daemon (`docker ps` must succeed), and
`npm`.

## `/worker` — the R + FastAPI compute container

This is the fastest loop for iterating on R changes: the container needs no credentials and
no network, so you can drive it directly with `curl` without the edge Worker involved at
all.

```sh
cd worker
docker build --platform linux/amd64 -t taxsea-worker:test -f Dockerfile .
```

The base image (`bioconductor/bioconductor_docker:RELEASE_3_23`) is large — expect the first
build to take a while and produce a multi-GB image (**5.19 GB** as recorded in
[`worker/README.md`](../worker/README.md)); rebuilds after that are fast because Docker
caches every layer up to the one you changed.

Run it with a shared secret (any value works locally; the container only compares it against
whatever you send back in the `Authorization` header):

```sh
docker run --rm -p 8080:8080 -e WORKER_SHARED_SECRET=test-secret taxsea-worker:test
```

In another terminal, confirm it's up:

```sh
curl -s http://localhost:8080/health
# Healthy: TaxSEA 1.4.0
```

Exercise `POST /run` with one of the committed fixtures. The fixtures under
`worker/tests/fixtures/` are `POST /api/jobs` request bodies (`mode` + `ranks`/`taxa` +
`options`); the container's `/run` additionally requires a `jobId` (a UUIDv4 — the edge
router normally mints this), so add one with `jq`:

```sh
jq '. + {jobId: "3fa85f64-5717-4562-b3fc-2c963f66afa6"}' \
  tests/fixtures/enrichment_input.json > /tmp/run_body.json

curl -s -X POST http://localhost:8080/run \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  --data @/tmp/run_body.json | jq '.status, .executionTimeMs, (.results | keys)'
```

A working run returns `"completed"`, an execution time in milliseconds, and the result
collection names TaxSEA returned (e.g. `All_databases`, `Metabolite_producers`,
`BugSigDB`, ...). A `401` means the `Authorization` header didn't match
`WORKER_SHARED_SECRET`; see the troubleshooting section below.

Run the test suites:

```sh
pip install -r requirements-dev.txt
pytest
```

`pytest` runs outside the container with the `Rscript` subprocess mocked — it's fast and
tests the FastAPI wrapper's request handling, auth, and error shapes. The R-level test
(`tests/test_worker_r.R`) exercises the real `worker.R` CLI against real TaxSEA, so it has
to run **inside** the built image (`tests/` isn't copied into the image — it's excluded via
`.dockerignore` — so bind-mount it in):

```sh
docker run --rm -v "$PWD/tests:/app/tests:ro" taxsea-worker:test \
  Rscript tests/test_worker_r.R
```

This is the same command CI runs in `ci-worker.yml`'s `build-image` job, against its own
`taxsea-worker:ci` build.

## `/edge` — the Cloudflare Worker, DO, and R2

```sh
cd edge
npm install
cp .dev.vars.example .dev.vars   # fill in a real WORKER_SHARED_SECRET; gitignored
npm run dev                      # wrangler dev
```

`.dev.vars` supplies `WORKER_SHARED_SECRET` for local dev, exactly the variable name
declared in `edge/wrangler.toml`'s `[vars]`/secret setup and forwarded to the container via
`JobCoordinatorDO`'s `envVars` — the same env var the worker container checks in §"How it
works" above. Keep the value identical to whatever you passed as `-e
WORKER_SHARED_SECRET=...` when running the container by hand in the previous section, if
you want to compare behavior.

`wrangler dev` **builds and runs the `/worker` container image locally** as part of
starting up, which is why it needs a working Docker daemon. The first run is slow — it's
building the same multi-GB image from the previous section from scratch if you haven't
already built it with `docker build` there; subsequent runs reuse Docker's layer cache and
start much faster.

`wrangler dev` needs a Cloudflare account with the Workers Paid plan (Cloudflare Containers
requirement, see `PLAN.md` §2.1) and a `wrangler login` / `CLOUDFLARE_API_TOKEN`. Without
that, this step can't be exercised end-to-end — the sections above (`docker build` +
`docker run` + `curl`) are still a fully self-contained way to test the R/container side
without any Cloudflare credentials at all.

## `/frontend` — the React SPA

```sh
cd frontend
npm install
npm run dev                      # vite, default http://localhost:5173
```

Vite's dev server proxies `/api` (see `frontend/vite.config.ts`) to
`http://localhost:8787`, which is `wrangler dev`'s default port — so `wrangler dev` (the
`/edge` section above) has to be running first for the frontend dev server to do anything
useful. The proxy config sets `ws: true` on the `/api` route, which is what lets the
browser's WebSocket connection to `/api/jobs/:jobId/ws` reach `wrangler dev` at all; without
it, only plain HTTP requests would proxy and the WebSocket upgrade would fail (see
Troubleshooting).

## Running the whole stack locally

Three terminals, in order:

```sh
# Terminal 1 — edge (builds/runs the container on first start; can take a while)
cd edge && npm run dev

# Terminal 2 — frontend, once terminal 1 shows wrangler dev is listening on :8787
cd frontend && npm run dev

# Terminal 3 — proof it works end to end
curl -s -X POST http://localhost:5173/api/jobs \
  -H "Content-Type: application/json" \
  --data @../worker/tests/fixtures/enrichment_input.json
```

A working stack returns `201` with a `jobId`, `status: "queued"`, and `wsUrl`/`stateUrl`/
`resultUrl`. Open the SPA at `http://localhost:5173`, submit the same fixture through the
form (or use "Load example data" if the frontend provides it), and watch the job progress
from `queued` → `running` → `completed` over the WebSocket, then fetch
`/api/jobs/:jobId/result` (or click through in the UI) to see the TaxSEA output.

## Cold-start latency

Every job gets a **fresh container** — there's no warm pool (`PLAN.md` §2.1, "accepted
trade-off"). Per `PLAN.md` §7 ("Risks"), booting a multi-GB Bioconductor image plus R
startup "could plausibly reach tens of seconds before analysis even begins." Don't mistake
a job sitting in `running` for the first 10-30+ seconds for a hang — that's expected cold
boot time, which is also why the job timeout is set to 300 s rather than something tight.

## `lookup_missing` is disabled

The container always calls TaxSEA with `lookup_missing = FALSE` (`docs/api.md` §7) — it
never falls back to querying NCBI's Entrez API for taxon names it doesn't recognize, because
that would let a public endpoint make the service hammer a third-party API on a caller's
behalf. This means: **taxon names must already match TaxSEA's bundled `NCBI_ids` mapping**,
or they're silently dropped from the results with no error.

To check whether a specific name is recognized before submitting a job, run TaxSEA's own
`get_taxon_sets()` — in any R session with TaxSEA installed, or directly inside the built
worker image with no extra setup:

```sh
docker run --rm taxsea-worker:test \
  Rscript -e 'library(TaxSEA); print(get_taxon_sets(taxon = "Bifidobacterium_longum"))'
```

If this returns taxon sets, the name is recognized. An empty/`NA` result means either the
name isn't in TaxSEA's bundled mapping (try a different spelling or taxonomic rank) or it
simply isn't a member of any curated taxon set — both look the same from the outside, which
is the root cause of the "empty results" failure mode below.

## Troubleshooting

**First `wrangler dev` invocation appears to hang.** It isn't — it's building the
multi-GB container image (see the `/edge` section above). Building it once yourself with
`docker build --platform linux/amd64 ...` (as documented in `/worker` above) both warms
Docker's cache so subsequent `wrangler dev` starts are fast, and lets you watch build output
directly instead of waiting on `wrangler`'s summarized progress.

**A job gets stuck in `running` and never completes.** The container failed to start or
crashed after starting. Run `wrangler tail` (or check the `wrangler dev` terminal directly)
for the container's stderr/stdout — a missing `WORKER_SHARED_SECRET`, an out-of-disk error,
or an R crash all show up there. The job's timeout alarm (300 s) eventually flips it to
`timed_out` if nothing else does.

**The container returns `401` on `/run`.** `WORKER_SHARED_SECRET` in `edge/.dev.vars`
doesn't match the value `wrangler dev` forwarded to the container's `envVars`. Confirm
`.dev.vars` has a value set (not the `change-me-in-local-dev-only` placeholder left as-is if
you forgot to edit it) and restart `wrangler dev` after changing it — env vars are read at
container start.

**The WebSocket never connects from the frontend.** Almost always the Vite proxy: confirm
`frontend/vite.config.ts` has `ws: true` on the `/api` proxy entry (without it, only plain
HTTP proxies and the `Upgrade: websocket` request never reaches `wrangler dev`), and confirm
`wrangler dev` is actually listening on the port the proxy targets (`:8787` by default).

**Results come back empty even though the job completed.** Almost always taxon names that
don't match TaxSEA's bundled database — see "`lookup_missing` is disabled" above. Check a
handful of your input names with `get_taxon_sets()` before assuming something is broken.

**Trying to give the container network or storage access.** Don't — this is intentional,
not a gap to fill in. The container runs with `enableInternet = false` and holds no R2/S3
credentials of any kind; the Durable Object does all R2 reads and writes through its native
binding and passes data to and from the container by value in the `/run` request/response
body (`PLAN.md` §2.6). If you find yourself reaching for a cloud SDK or a credential
environment variable inside `/worker`, the DO is where that logic belongs instead.
