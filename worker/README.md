# worker

R + FastAPI compute container image source. Runs TaxSEA via `Rscript` behind a small
synchronous `/run` endpoint. Has no storage credentials and no network access — the edge
Durable Object passes input by value and receives the result by value (see PLAN.md §2.6).

Built and deployed as a Cloudflare Container declared in `/edge/wrangler.toml`; there is no
standalone deploy pipeline for this directory.

See [`../docs/development.md`](../docs/development.md) for exercising `POST /run` with
`curl` against a fixture payload, and for the whole-stack local setup.

## Image size

`docker build --platform linux/amd64 -t taxsea-worker:test -f Dockerfile .` produces a
**5.21 GB** image (base `bioconductor/bioconductor_docker:RELEASE_3_23` plus TaxSEA,
jsonlite, bugsigdbr, and their Bioconductor/system dependencies, including a pre-warmed
BugSigDB data cache -- see below). This is larger than the 1-3 GB this project originally
planned around — the Bioconductor base image itself is the majority of that weight. Adding
`bugsigdbr` only grew the image by ~20-30 MB over the pre-`bugsigdbr` 5.19 GB baseline
(issue #61): the `bioconductor_docker` base image already ships most of `bugsigdbr`'s
dependencies (dplyr, tidyr, RSQLite, BiocFileCache, etc.), and the cached BugSigDB dataset
itself is small. It still comfortably fits `standard-1`'s 8 GB instance disk (see
`/edge/wrangler.toml`) with no `instance_type` bump needed; if a future change to `worker/`
(e.g. adding another Bioconductor package) pushes the image close to 8 GB, bump
`instance_type` to `standard-2` (12 GB disk) rather than trying to slim this image down.

## bugsigdbr: a build-time-only network dependency

TaxSEA's BugSigDB results collection comes not from TaxSEA's own bundled `TaxSEA_db` (which
has zero BugSigDB-prefixed entries) but from a separate Bioconductor package, `bugsigdbr`
(Waldron lab), that TaxSEA queries at analysis time. `bugsigdbr` does not bundle BugSigDB
data in the package itself — it lazily downloads and caches it via `BiocFileCache` into
`$HOME/.cache/R/bugsigdbr/BiocFileCache.sqlite` the first time it's needed.

This container runs with `enableInternet = false` in production (PLAN.md §2.6,
`edge/src/JobCoordinatorDO.ts`) — no outbound network at request time. So the Dockerfile
installs `bugsigdbr` *and* pre-warms its `BiocFileCache` cache in a `RUN` step that executes
a real `TaxSEA(..., mode = "enrichment")` call, after `USER appuser` (the cache path is
`$HOME`-relative, and the runtime process runs as `appuser`). That `RUN` step has network
access (it's part of the image build) and its output — the populated cache — is baked into
the image layer, so no network call happens at job-run time. The same `RUN` step asserts
`nrow(res$BugSigDB) > 0`, so a build fails loudly if the pre-warm didn't actually work,
rather than shipping an image that silently degrades in production (see issue #61).

Pre-warming the cache is necessary but not sufficient. `BiocFileCache` treats every cached
resource fetched from a URL as a "web" resource and, on *every* subsequent read (not just
the first), does a live HTTP HEAD request to the upstream host to decide whether the local
copy is stale (`BiocFileCache::bfcneedsupdate()`). With no network, that HEAD request fails,
and `bugsigdbr`'s fallback path then attempts a real re-download — which also fails, and
propagates as a hard error out of `TaxSEA()` (verified directly: without the next paragraph's
fix, `docker run --network none` throws `Error: download failed; see warnings()` instead of
returning results — worse than the original bug, since it now fails the *entire* job instead
of just leaving BugSigDB empty).

`worker.R` therefore overrides `BiocFileCache::bfcneedsupdate()` at process start (via
`setMethod`) to always report "no update needed," so the pre-warmed cache is trusted rather
than revalidated. This is safe unconditionally in this container because it never has
network access at request time by design — there is no scenario in production where
revalidating against the live BugSigDB host is even possible, so skipping it is always
correct here.

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
