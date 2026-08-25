# TaxSEA-online

An asynchronous web service for taxon-set enrichment analysis using the Bioconductor package
[TaxSEA](https://bioconductor.org/packages/TaxSEA/). Users submit a ranked or unranked taxon
list from a React SPA, the job runs in an on-demand Cloudflare Container, and results stream
back over a WebSocket — no external queue, database, or second cloud.

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

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Further reading

- [`spec.md`](./spec.md) — original engineering specification
- [`PLAN.md`](./PLAN.md) — authoritative architecture review, deviations, and issue breakdown
