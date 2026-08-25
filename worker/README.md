# worker

R + FastAPI compute container image source. Runs TaxSEA via `Rscript` behind a small
synchronous `/run` endpoint. Has no storage credentials and no network access — the edge
Durable Object passes input by value and receives the result by value (see PLAN.md §2.6).

Built and deployed as a Cloudflare Container declared in `/edge/wrangler.toml`; there is no
standalone deploy pipeline for this directory.
