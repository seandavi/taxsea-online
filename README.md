# TaxSEA-online

An asynchronous web service for taxon-set enrichment analysis using the Bioconductor package
[TaxSEA](https://bioconductor.org/packages/TaxSEA/). Users submit a ranked or unranked taxon
list from a React SPA, the job runs in an on-demand Cloudflare Container, and results stream
back over a WebSocket — no external queue, database, or second cloud.

For microbiome researchers who have a differential-abundance result (a ranked list of taxa,
or just a taxon list from an ORA-style workflow) and want to know whether known taxon sets —
metabolite producers, disease associations, curated signatures from BugSigDB, MiMeDB,
GutMGene, mBodyMap, and GMRepoV2 — are enriched in it, without installing R or Bioconductor
locally.

**Live:** <!-- TODO: production URL once issue #20 deploys -->

## How it works

A submission is a single async job, not a request/response call: `POST /api/jobs` returns
immediately with a `jobId` and hands off to a `JobCoordinatorDO` (a Cloudflare Durable
Object), which writes the input to R2, boots a fresh, per-job Cloudflare Container bound
directly to itself, and calls it synchronously over a private port. The container runs
TaxSEA via `Rscript` with no network access and no storage credentials, returns the result
by value in the HTTP response, and the DO writes it to R2 and flips the job to `completed`.
The frontend either holds open a WebSocket for a live push the instant that happens, or
polls `/state` as a fallback, then fetches `/result`, which the Worker proxies from R2 so
the bucket itself is never public. See "Architecture" below and
[`docs/api.md`](./docs/api.md) for the full contract.

## Architecture

Everything ships from a single `wrangler deploy`: the Worker, the `JobCoordinatorDO` Durable
Object, the R2 bucket binding, the SPA static assets, and the compute container image itself
(built by Cloudflare Containers directly from `/worker/Dockerfile`). See
[`PLAN.md`](./PLAN.md) §2.1 for why this replaces the external container platform
(Cloud Run/Fly.io/ECS) proposed in [`spec.md`](./spec.md) §1.

```text
[ React Frontend (served as static assets by the Worker) ]
  │
  ├── 1. POST /api/jobs (submit taxa data) ─────────────► [ Cloudflare Worker / Router ]
  │                                                                │
  │   ┌────────────────────────────────────────────────────────────┘
  │   ▼
  │ [ Durable Object: JobCoordinatorDO  (extends Container) ]
  │   ├── 2. Writes input.json ─────────────────────────► [ Cloudflare R2 ]  (native binding)
  │   ├── 3. Sets timeout alarm (300s)
  │   └── 4. this.containerFetch(POST /run) ────────────► [ Bound Container: R + FastAPI ]
  │                                                                │ (synchronous, no network,
  ├── 5. Connects wss://.../api/jobs/:id/ws                       │  no storage credentials)
  │   ◄── Streams JobState { status: "running" }                  ├── 6. Runs TaxSEA via Rscript
  │                                                                └── 7. Returns result by value
  │   ┌────────────────────────────────────────────────────────────┘
  │   ▼
  │ [ Durable Object: JobCoordinatorDO ]
  │   ├── 8. Writes output.json ────────────────────────► [ Cloudflare R2 ]
  │   ├── 9. Cancels timeout alarm
  │   └── 10. Broadcasts JobState { status: "completed" }
  │
  └── 11. GET /api/jobs/:id/result ─────────────────────► [ Worker proxies from R2 binding ]
```

Key deviations from `spec.md`'s original diagram (full detail in `PLAN.md` §1–§2):
the container is a **binding** on the same Durable Object, not a separate HTTP service behind
a webhook callback; the container has **no R2/S3 credentials and no network egress** — the DO
does all storage I/O and passes payloads to the container by value; and results are **proxied
through the Worker** rather than fetched from a public bucket or a second domain.

## Components

| Directory | Purpose |
|---|---|
| [`/worker`](./worker/README.md) | R + FastAPI compute container image source |
| [`/edge`](./edge/README.md) | Cloudflare Worker, `JobCoordinatorDO`, R2, and SPA hosting |
| [`/frontend`](./frontend/README.md) | React SPA (Vite) |
| [`/docs`](./docs/README.md) | API contracts, infrastructure, and development docs |
| [`/.github/workflows`](./.github/workflows/README.md) | CI and deploy workflows |

## Local development

See [`docs/development.md`](./docs/development.md) for the full three-component local setup,
including the exact terminal-by-terminal sequence to run the whole stack and a
troubleshooting section for the common failure modes.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Citation

This service is a thin web wrapper around the Bioconductor package **TaxSEA**; the
enrichment analysis itself is entirely TaxSEA's. If you use results from this service in
published work, cite the package:

> Pham CM, Rankin TJ, Stinear TP, Walsh CJ, Ryan FJ. TaxSEA: rapid interpretation of
> microbiome alterations using taxon set enrichment analysis and public databases.
> *Briefings in Bioinformatics*. 2025;26(2):bbaf173. doi:
> [10.1093/bib/bbaf173](https://doi.org/10.1093/bib/bbaf173)

Package homepage: [bioconductor.org/packages/TaxSEA](https://bioconductor.org/packages/TaxSEA/)
· source: [github.com/feargalr/TaxSEA](https://github.com/feargalr/TaxSEA)

## License

This repository (the Worker, Durable Object, container wrapper, frontend, and docs) is
[MIT-licensed](./LICENSE). TaxSEA itself is **GPL-3** and is never linked into or
redistributed as part of this codebase — it is installed in the container image and
invoked as an arm's-length `Rscript` subprocess (see [`worker/worker.R`](./worker/worker.R)),
the same relationship any GPL command-line tool has when shelled out to.

## Further reading

- [`spec.md`](./spec.md) — original engineering specification
- [`PLAN.md`](./PLAN.md) — authoritative architecture review, deviations, and issue breakdown
