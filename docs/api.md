# TaxSEA-online API and data contracts

Frozen in M1, before any implementation starts (issue #2). This document is the single
source of truth for the public HTTP API, the internal DO -> container contract, R2 layout,
input limits, and the fields deliberately not exposed. `spec.md` §3 predates this document
and is superseded by it wherever the two disagree — in particular the output contract in
`spec.md` §3.3 (`Metabolite_producers` / `median_rank` / `pValue` / `taxaInSet`) does not
match TaxSEA 1.4.0's actual return value and must not be implemented.

## 1. Public HTTP API

Served by the edge Worker, same origin as the SPA (no CORS needed for first-party use).

### `POST /api/jobs`

Submits a new enrichment or ORA job.

**Request body** — one of two shapes, selected by `mode`:

Enrichment mode (named numeric rank vector):

```json
{
  "mode": "enrichment",
  "ranks": { "Bifidobacterium_longum": 2.45, "Ruminococcus_bromii": -3.05 },
  "options": { "minSetSize": 5, "maxSetSize": 100 }
}
```

ORA mode (taxon name array):

```json
{ "mode": "ora", "taxa": ["Bifidobacterium_longum", "Bacteroides_thetaiotaomicron"] }
```

`options` is always optional; omitted fields fall back to server defaults. See §4 for the
validation and clamping applied to every field in this body.

**Responses:**

- `201 Created` — job accepted and dispatched.

  ```json
  {
    "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "queued",
    "wsUrl": "/api/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6/ws",
    "stateUrl": "/api/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6/state",
    "resultUrl": "/api/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6/result"
  }
  ```

- `400 Bad Request` — body fails validation (see §4): too large, wrong `mode`, taxa count out
  of range, a taxon name failing the name regex, a non-finite rank, unknown top-level keys,
  etc.

  ```json
  { "error": "invalid_request", "message": "taxa must contain between 1 and 5000 entries" }
  ```

- `429 Too Many Requests` — the caller's IP has exceeded the rate limit on this endpoint (see
  §6).

  ```json
  { "error": "rate_limited", "message": "Too many job submissions. Try again shortly." }
  ```

### `GET /api/jobs/:jobId/state`

Polls the current `JobState` for a job (see §3 for the shape). Used as the fallback when a
WebSocket connection isn't available or drops.

**Responses:**

- `200 OK`

  ```json
  {
    "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "running",
    "createdAt": 1735084800000,
    "startedAt": 1735084800500,
    "finishedAt": null,
    "executionTimeMs": null,
    "error": null
  }
  ```

- `404 Not Found` — `jobId` does not correspond to a known job (never existed, or the DO has
  no state stored for it).

  ```json
  { "error": "not_found", "message": "No job found for this id" }
  ```

### `GET /api/jobs/:jobId/ws`

Upgrades to a WebSocket. The server pushes the full `JobState` object (§3) every time it
changes — on `running`, `completed`, `failed`, and `timed_out` transitions — and sends the
current state immediately on connect. The client sends no messages; this is a read-only
push channel.

**Responses:**

- `101 Switching Protocols` — the upgrade succeeds; subsequent `JobState` frames arrive as
  WebSocket text messages.
- `426 Upgrade Required` — the request did not carry `Upgrade: websocket`.
- `403 Forbidden` — the `Origin` header does not match the Worker's own origin (see §6).
- `404 Not Found` — `jobId` does not correspond to a known job.

### `GET /api/jobs/:jobId/result`

Streams `output.json` for a completed job, proxied from R2 through the DO's native binding.
The bucket itself is never public and `outputKey` is never exposed to the client — this
endpoint is the only way to fetch a result.

**Responses:**

- `200 OK` — body is the `output.json` envelope (§5), `Content-Type: application/json`.
- `404 Not Found` — the job does not exist, or exists but has not reached `completed` (no
  object has been written to R2 yet — poll `/state` or listen on `/ws` first).

  ```json
  { "error": "not_found", "message": "No result available for this job" }
  ```

### `GET /api/health`

Liveness check for uptime monitoring, per platform convention. Checks R2 reachability and a
DO round-trip only — it deliberately does **not** probe the compute container, since doing so
would pull and cold-boot a multi-GB image on every health check.

**Responses:**

- `200 OK` — body contains the literal string `Healthy`.
- `503 Service Unavailable` — R2 or the DO round-trip failed.

### No `/api/jobs/:id/callback` endpoint

`spec.md` §2 steps 9-11 describe the compute worker POSTing a webhook callback back to the
edge on completion. That endpoint **does not exist** in this design. The compute container is
bound directly to the Durable Object (Cloudflare Containers) and is not internet-reachable at
all; the DO calls the container synchronously via `containerFetch` and reads the result
straight from the response body (§2). There is nothing for a callback to call.

## 2. Internal DO -> container contract

The container has **no cloud access at all**: it runs with `enableInternet = false` and holds
no storage credentials. The Durable Object performs every R2 read and write itself, through
its native `R2Bucket` binding, and hands the container only the data it needs by value — in
the request and response bodies of a single internal call.

```
POST http://localhost:8080/run
  Authorization: Bearer <WORKER_SHARED_SECRET>
```

- Reached via `this.containerFetch(...)` on a **private port** — never routed through the
  public Worker, never reachable from the internet, and not a URL configured anywhere
  client-facing.
- **Synchronous**: the DO's call to `/run` returns only when the R analysis has finished (or
  errored). There is no separate callback leg.
- The request body carries the already-validated submission payload by value:

  ```json
  { "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "mode": "enrichment",
    "ranks": { "...": 0 }, "options": { "minSetSize": 5, "maxSetSize": 100 } }
  ```

  (or `"taxa": [...]` in place of `"ranks"` for `mode: "ora"`).

**Responses:**

- `200 OK`, job-level success — the analysis ran and produced results. This response body
  **is** the `output.json` envelope (§5) verbatim; the DO writes it to R2 unchanged.

  ```json
  { "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "status": "completed",
    "executionTimeMs": 2340, "taxsea": { "...": "..." }, "results": { "...": "..." } }
  ```

- `200 OK`, job-level failure — the request was well-formed but the R analysis itself failed
  (e.g. an `Rscript` error, or no taxa matched TaxSEA's bundled database). HTTP 200 is used
  deliberately here so the DO can distinguish "the analysis ran and failed" from "the request
  itself was rejected" below.

  ```json
  { "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "status": "failed",
    "executionTimeMs": 118, "error": "No input taxa matched the TaxSEA reference database" }
  ```

- `4xx` / `5xx` — request-level errors: bad or missing `Authorization`, malformed JSON body,
  or an internal container fault before an R run could even start. These are infrastructure
  failures, not job outcomes, and are handled distinctly from the two `200` shapes above.

No storage keys, presigned URLs, or credentials of any kind cross this boundary in either
direction — the container never touches R2.

## 3. `JobState` (WebSocket / `/state` payload)

The only object ever pushed over the WebSocket, and the only body returned by
`GET /api/jobs/:jobId/state`:

```json
{
  "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "queued",
  "createdAt": 1735084800000,
  "startedAt": null,
  "finishedAt": null,
  "executionTimeMs": null,
  "error": null
}
```

- `status` is one of `queued | running | completed | failed | timed_out`.
- `outputKey` is deliberately **not** included. Results are fetched exclusively via
  `GET /api/jobs/:jobId/result`, which streams from R2 through the DO — this keeps the R2
  bucket private and the key layout (§4) off the wire entirely.
- The DO writes `output.json` to R2 **before** flipping `status` to `completed`, so any client
  observing `completed` can always successfully call `/result` immediately after.

## 4. R2 key layout and `jobId`

```
jobs/{jobId}/input.json
jobs/{jobId}/output.json
```

- **Only the Durable Object reads or writes these keys.** The container never receives an R2
  key or credential of any kind (§2); the frontend never receives one either (§3).
- `jobId` is **server-generated** with `crypto.randomUUID()` by the router on `POST /api/jobs`
  — any client-supplied `jobId` in the request body is ignored. Before ever being interpolated
  into an R2 key, `jobId` is validated against the UUIDv4 regex:

  ```
  ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
  ```

  This check is defence in depth against path traversal (e.g. a `jobId` of `../../evil`)
  layered on top of the fact that the value is never taken from client input in the first
  place.

## 5. Input limits (enforced at the edge, on `POST /api/jobs`)

| Limit | Value |
|---|---|
| Request body size | <= 1 MiB |
| Number of taxa (`ranks` keys or `taxa` array length) | 1 to 5000 |
| Taxon name pattern | `^[A-Za-z0-9_. -]{1,200}$` |
| Rank values | must be finite numbers — `NaN`, `Infinity`, `-Infinity`, and numeric strings are all rejected |
| `options.minSetSize` / `options.maxSetSize` | clamped to the range 2 to 1000 |

Requests failing any of these return `400 Bad Request` (§1) before the job is dispatched to
the container — rejection has to be cheap, because an accepted request boots a per-job,
multi-GB container.

## 6. Other edge-enforced controls

- **Rate limiting:** `POST /api/jobs` only, keyed on `CF-Connecting-IP`, via Cloudflare's
  native rate-limiting binding. Read endpoints (`/state`, `/ws`, `/result`, `/health`) are
  unlimited so a legitimate page can poll freely. `max_instances` on the container
  configuration is the hard ceiling on concurrent spend, independent of this per-IP limit.
- **WebSocket origin check:** the `/ws` upgrade path validates the `Origin` header against
  the Worker's own origin before completing the handshake, since a WebSocket upgrade is not
  subject to CORS.
- **R stderr sanitization:** any R error message surfaced to the client (as `JobState.error`
  or in the `output.json` failure shape) is truncated to 2000 characters with absolute
  filesystem paths stripped, since R errors can otherwise echo submitted input content.

## 7. `customDb` and `lookup_missing` are not exposed in v1

TaxSEA's R API accepts a `custom_db` argument (an arbitrary user-supplied taxon-set database)
and a `lookup_missing` flag (fetch unmapped taxon IDs from the NCBI Entrez API at run time).
**Neither is exposed through the public submission body, and the container always calls
TaxSEA with `lookup_missing = FALSE` and no `custom_db`.**

Reason: both widen the abuse surface of a public, unauthenticated endpoint.

- An arbitrary user-supplied database (`customDb`) run inside the compute container has no
  practical size or content limit the edge could validate, and there is no use case in v1 for
  anything other than TaxSEA's bundled reference sets.
- `lookup_missing = TRUE` makes the container call the NCBI Entrez API, once per taxon name
  not already present in TaxSEA's bundled `NCBI_ids` mapping, synchronously inside the job. On
  a public endpoint this would let any caller make the service hammer a third-party API
  (NCBI) with an unbounded number of requests per job, entirely outside our control and
  outside NCBI's usage policy. Taxa not present in the bundled mapping are silently dropped
  from results instead — a known v1 limitation, not a bug.

## 8. `output.json` envelope

Returned by the container as the `200`/`status: "completed"` body of `/run` (§2), and written
to R2 at `jobs/{jobId}/output.json` by the DO **unchanged**:

```json
{
  "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "completed",
  "executionTimeMs": 2340,
  "taxsea": {
    "packageVersion": "1.4.0",
    "mode": "enrichment",
    "params": { "minSetSize": 5, "maxSetSize": 100 }
  },
  "results": {
    "All_databases": {
      "columns": ["taxonSetName", "median_rank_of_set_members", "PValue", "Test_statistic", "FDR"],
      "rows": [
        {
          "taxonSetName": "MiMeDB_producers_of_GABA",
          "median_rank_of_set_members": 1.85,
          "PValue": 3.4e-9,
          "Test_statistic": 0.62,
          "FDR": 1.2e-7
        }
      ]
    }
  }
}
```

The `results` keys are **whatever TaxSEA returns** — the package's own example uses
`res$All_databases`, but collection names and even column sets vary by mode and can change
across Bioconductor releases. Do not hardcode collection names anywhere in the pipeline, and
do not rename columns. `columns` preserves the display order TaxSEA returned, so the frontend
can iterate `Object.entries(results)` and render generically without knowing in advance what
TaxSEA will call anything.

Serialization uses `jsonlite::write_json(..., auto_unbox = TRUE, digits = NA)` on the R side —
**not** `digits = 6`. A fixed `digits` rounds small p-values (anything below `1e-6`) to `0`,
silently deleting exactly the significant findings a user came for; `digits = NA` preserves
full numeric precision through the round trip.

See `/worker/tests/fixtures/expected_output_shape.json` and
`/edge/test/fixtures/expected_output_shape.json` for a full worked example of this shape.

## 9. Fixtures

Three fixture files, committed identically under both `/worker/tests/fixtures/` and
`/edge/test/fixtures/` (duplicated on purpose, not shared or symlinked, so each component's
test suite builds and runs independently):

- **`enrichment_input.json`** — a `POST /api/jobs` enrichment-mode body. `ranks` is TaxSEA's
  own bundled `TaxSEA_test_data` (164 named log-fold-change-style rank values, e.g.
  `"Faecalibacterium_prausnitzii": -4.04`, `"Bifidobacterium_longum": -2.441`,
  `"Bacteroides_thetaiotaomicron": 1.908`), taken verbatim from
  `data/TaxSEA_test_data.rda` in the [feargalr/TaxSEA](https://github.com/feargalr/TaxSEA)
  GitHub repository — the same object the package's own vignette and `?TaxSEA_test_data`
  example (`test_results <- TaxSEA(TaxSEA_test_data)`) run against. This gives the E2E test a
  known-good input with a known-plausible result, rather than an invented one.
- **`ora_input.json`** — a `POST /api/jobs` ORA-mode body. `taxa` is a 12-name subset of the
  same real `TaxSEA_test_data` taxon names, so both fixtures draw from one real, traceable
  source.
- **`expected_output_shape.json`** — a realistic (not necessarily numerically exact) example
  of the full `output.json` envelope from §8, using the real TaxSEA column names
  (`taxonSetName`, `median_rank_of_set_members`, `PValue`, `Test_statistic`, `FDR`) under the
  `All_databases` results key.
