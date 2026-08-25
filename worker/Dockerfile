# Base image: bioconductor/bioconductor_docker:RELEASE_3_23 -- not rocker/r-ver:4.3.2 as
# spec.md §4.1 proposed. TaxSEA 1.4.0 (Bioconductor 3.23) declares `Depends: R (>= 4.5.0)`,
# so 4.3.2 fails at install time (PLAN.md §1.1). The Bioconductor image ships a
# version-matched R + Bioc toolchain, which avoids compiling R itself and keeps the
# BiocManager version pin meaningful.
FROM bioconductor/bioconductor_docker:RELEASE_3_23

# --- R / Bioconductor layer --------------------------------------------------
# Pinned to Bioconductor 3.23 explicitly -- an unpinned BiocManager::install tracks devel,
# which makes builds non-reproducible and can silently change result column names (issue #3
# notes). Errors are not swallowed: BiocManager::install() stops the R process (and this RUN
# layer, and the build) on any package install failure by default.
RUN Rscript -e " \
      BiocManager::install(version = '3.23', ask = FALSE, update = FALSE); \
      BiocManager::install(c('TaxSEA', 'jsonlite'), ask = FALSE, update = FALSE)"

# Build-time smoke check: confirm the package and its bundled example data both load.
#
# Deviation from issue #3's literal suggestion: the issue proposes
# `stopifnot(nrow(TaxSEA_test_data) > 0)`. Issue #2's PR found that TaxSEA_test_data is
# actually a *named numeric vector* (not a data.frame) in the real .rda from
# github.com/feargalr/TaxSEA -- nrow() on a vector returns NULL, so `nrow(...) > 0` is
# `logical(0)` and stopifnot() on it errors even when the load succeeded. length() is the
# check that's actually correct for this data's real shape; the point of the check ("did the
# package and its bundled data load") is unchanged.
RUN Rscript -e " \
      library(TaxSEA); \
      data('TaxSEA_test_data'); \
      stopifnot(length(TaxSEA_test_data) > 0)"

# --- Python layer -------------------------------------------------------------
# Deliberately its own layer, ordered so that changing requirements.txt never invalidates
# (and forces a recompile of) the R/Bioconductor layers above, and changing TaxSEA/jsonlite
# versions never forces a reinstall of Python deps.
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY main.py worker.R ./

# --- Runtime user ---------------------------------------------------------------
# No explicit --uid: the bioconductor_docker base image already has a user at uid 1000
# (rstudio-server's default), so a hardcoded 1000 collides. Let useradd pick a free one.
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
