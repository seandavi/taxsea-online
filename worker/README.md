# worker

R + FastAPI compute container image source. Runs TaxSEA via `Rscript` behind a small
synchronous `/run` endpoint. Has no storage credentials and no network access — the edge
Durable Object passes input by value and receives the result by value (see PLAN.md §2.6).

Built and deployed as a Cloudflare Container declared in `/edge/wrangler.toml`; there is no
standalone deploy pipeline for this directory.

## Image size

`docker build --platform linux/amd64 -t taxsea-worker:test -f Dockerfile .` produces a
**5.19 GB** image (base `bioconductor/bioconductor_docker:RELEASE_3_23` plus TaxSEA,
jsonlite, and their Bioconductor/system dependencies). This is larger than the 1-3 GB this
project originally planned around — the Bioconductor base image itself is the majority of
that weight. It still fits `standard-1`'s 8 GB instance disk (see `/edge/wrangler.toml`), but
with less headroom than planned; if a future change to `worker/` (e.g. adding another
Bioconductor package) pushes the image close to 8 GB, bump `instance_type` to `standard-2`
(12 GB disk) rather than trying to slim this image down.

## Tests

Python (`main.py`) tests run outside the container, with the `Rscript` subprocess mocked:

```
pip install -r requirements-dev.txt
pytest
```

The R-level test (`tests/test_worker_r.R`) runs the real `worker.R` CLI against real TaxSEA,
so it must run inside the built image. `tests/` is excluded from the image build
(`.dockerignore`), so bind-mount it in:

```
docker run --rm -v "$PWD/tests:/app/tests:ro" taxsea-worker:test Rscript tests/test_worker_r.R
```

(`taxsea-worker:test` is the tag from the `docker build` command above; CI runs the same
command against its own `taxsea-worker:ci` build in `.github/workflows/ci-worker.yml`.)
