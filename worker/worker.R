# Rscript entrypoint invoked by main.py's POST /run handler.
#
# Usage: Rscript worker.R <input_path> <output_path>
#
# Reads the POST /api/jobs request body (payload) from <input_path>, runs TaxSEA in
# enrichment or ORA mode, and writes the output.json envelope documented in
# /docs/api.md §8 to <output_path>.
#
# jobId: read from payload$jobId (the sidecar/DO writes the already-validated
# submission payload -- which includes jobId -- to input.json before invoking this
# script; see docs/api.md §2). argv[3] is not used for jobId -- there are only two
# CLI args (input_path, output_path).

suppressPackageStartupMessages({
  library(jsonlite)
  library(TaxSEA)
  library(BiocFileCache)
})

# TaxSEA's taxsea_prepare() calls bugsigdbr::importBugSigDB() to pull in BugSigDB
# signatures (issue #61). bugsigdbr caches that data on disk via BiocFileCache, but
# BiocFileCache's "web" resource type does a live HTTP HEAD revalidation against the
# upstream host on *every* read -- not just the first -- to decide whether the cached
# copy is stale. This container always runs with enableInternet = false (PLAN.md §2.6,
# edge/src/JobCoordinatorDO.ts), so that revalidation always fails, and the fallback
# path (a real re-download attempt) then hard-errors the whole TaxSEA() call, not just
# BugSigDB -- verified directly: without this override, `docker run --network none`
# throws "Error: download failed; see warnings()" instead of returning results.
#
# Since this container never has network access at request time by design, always
# trust the copy pre-warmed into the image at build time (worker/Dockerfile) instead of
# attempting to revalidate it. There is no legitimate runtime scenario where skipping
# revalidation is wrong here.
setMethod("bfcneedsupdate", "BiocFileCacheBase", function(x, rids, ...) {
  if (missing(rids)) rids <- BiocFileCache:::.get_all_web_rids(x)
  stats::setNames(rep(FALSE, length(rids)), rids)
})

main <- function(argv) {
  if (length(argv) < 2) {
    stop("Usage: Rscript worker.R <input_path> <output_path>")
  }
  input_path <- argv[1]
  output_path <- argv[2]

  payload <- jsonlite::fromJSON(input_path, simplifyVector = TRUE)
  # NA_character_ (not NULL): list(jobId = NULL, ...) drops the element's value from
  # jsonlite's serialization down to `{}` instead of `null`. NA_character_ round-trips
  # through na = "null" as a proper JSON null.
  job_id <- if (is.null(payload$jobId)) NA_character_ else payload$jobId

  min_set_size <- if (!is.null(payload$options$minSetSize)) payload$options$minSetSize else 5
  max_set_size <- if (!is.null(payload$options$maxSetSize)) payload$options$maxSetSize else 100

  start_time <- Sys.time()

  mode <- payload$mode
  if (identical(mode, "enrichment")) {
    ranks <- payload$ranks
    taxon_ranks <- as.numeric(ranks)
    names(taxon_ranks) <- names(ranks)
    res <- TaxSEA(
      taxon_ranks = taxon_ranks,
      mode = "enrichment",
      min_set_size = min_set_size,
      max_set_size = max_set_size,
      lookup_missing = FALSE,
      custom_db = NULL
    )
  } else if (identical(mode, "ora")) {
    res <- TaxSEA(
      input_taxa = as.character(payload$taxa),
      mode = "ora",
      min_set_size = min_set_size,
      max_set_size = max_set_size,
      lookup_missing = FALSE,
      custom_db = NULL
    )
  } else {
    stop(paste0("Unsupported mode: ", mode))
  }

  execution_time_ms <- as.integer(round(as.numeric(Sys.time() - start_time, units = "secs") * 1000))

  envelope <- list(
    jobId = job_id,
    status = "completed",
    executionTimeMs = execution_time_ms,
    taxsea = list(
      packageVersion = as.character(utils::packageVersion("TaxSEA")),
      mode = mode,
      params = list(minSetSize = min_set_size, maxSetSize = max_set_size)
    ),
    results = build_results(res)
  )

  jsonlite::write_json(
    envelope,
    output_path,
    auto_unbox = TRUE,
    digits = NA,
    na = "null"
  )
}

# Builds the `results` object from TaxSEA's named list of data frames, iterating
# names(res) -- no hardcoded collection names. Each collection becomes
# { columns: colnames(df), rows: [...] }, with a zero-row df producing rows: [].
build_results <- function(res) {
  out <- list()
  for (name in names(res)) {
    df <- res[[name]]
    if (nrow(df) == 0) {
      rows <- list()
    } else {
      # split a data.frame into a list of per-row named lists so jsonlite serializes
      # it as an array of objects (rows: [{...}, ...]) rather than a column-oriented
      # object.
      rows <- lapply(seq_len(nrow(df)), function(i) as.list(df[i, , drop = FALSE]))
    }
    # I() marks columns as AsIs so jsonlite's auto_unbox never collapses a
    # single-column data frame's colnames() down to a bare string.
    out[[name]] <- list(columns = I(colnames(df)), rows = rows)
  }
  out
}

result <- tryCatch(
  {
    main(commandArgs(trailingOnly = TRUE))
    NULL
  },
  error = function(e) {
    message(conditionMessage(e))
    quit(status = 1)
  }
)
