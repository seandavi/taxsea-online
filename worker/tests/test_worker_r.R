# Plain stopifnot script (no testthat). Run from the worker/ directory so the relative
# paths below (worker.R, tests/fixtures/...) resolve:
#
#   Rscript tests/test_worker_r.R
#
# Runs the real worker.R CLI entrypoint as a subprocess against both fixtures and
# asserts: the output.json envelope shape (docs/api.md §8), that results is non-empty,
# that an unsupported mode exits non-zero with a clear message, and that jsonlite's
# digits = NA / na = "null" options actually preserve 1e-12 and turn NA/NaN/Inf into
# JSON null -- verified directly against jsonlite, not assumed from the real TaxSEA run
# (whose p-values aren't guaranteed to be that extreme on any given fixture).

suppressPackageStartupMessages(library(jsonlite))

run_worker <- function(input_path, output_path) {
  status <- system2("Rscript", c("worker.R", input_path, output_path))
  stopifnot("worker.R exited non-zero on a valid fixture" = status == 0)
}

check_envelope <- function(out, expected_mode) {
  stopifnot(
    "jobId missing" = "jobId" %in% names(out),
    "status must be completed" = identical(out$status, "completed"),
    "executionTimeMs must be numeric" = is.numeric(out$executionTimeMs),
    "taxsea.packageVersion missing" = is.character(out$taxsea$packageVersion),
    "taxsea.mode mismatch" = identical(out$taxsea$mode, expected_mode),
    "taxsea.params.minSetSize missing" = is.numeric(out$taxsea$params$minSetSize),
    "taxsea.params.maxSetSize missing" = is.numeric(out$taxsea$params$maxSetSize),
    "results missing" = "results" %in% names(out),
    "results must be non-empty" = length(out$results) > 0
  )
  for (name in names(out$results)) {
    coll <- out$results[[name]]
    stopifnot(
      "collection missing columns" = "columns" %in% names(coll),
      "collection missing rows" = "rows" %in% names(coll),
      "columns must include PValue" = "PValue" %in% coll$columns
    )
  }
}

collect_pvalues <- function(out) {
  unlist(lapply(out$results, function(coll) {
    vapply(coll$rows, function(row) if (is.null(row$PValue)) NA_real_ else row$PValue, numeric(1))
  }))
}

# --- enrichment fixture ----------------------------------------------------
tmp_in <- tempfile(fileext = ".json")
tmp_out <- tempfile(fileext = ".json")
payload <- fromJSON("tests/fixtures/enrichment_input.json", simplifyVector = FALSE)
payload$jobId <- "test-job-enrichment"
write_json(payload, tmp_in, auto_unbox = TRUE)
run_worker(tmp_in, tmp_out)
out <- fromJSON(tmp_out, simplifyVector = FALSE)
check_envelope(out, "enrichment")
stopifnot("jobId not preserved through the envelope" = identical(out$jobId, "test-job-enrichment"))

# Regression check for issue #61: bugsigdbr must be installed and its BiocFileCache
# pre-warmed at image build time, or the BugSigDB collection silently comes back empty
# (a warning, not an error, from TaxSEA -- so nothing else here would catch it).
stopifnot(
  "BugSigDB collection missing from results" = "BugSigDB" %in% names(out$results),
  "BugSigDB must be non-empty (bugsigdbr not installed, or its cache not pre-warmed?)" =
    length(out$results$BugSigDB$rows) > 0
)
cat(sprintf("BugSigDB: %d rows\n", length(out$results$BugSigDB$rows)))

pvals <- na.omit(collect_pvalues(out))
stopifnot("expected at least one PValue in the enrichment results" = length(pvals) > 0)
min_pval <- min(pvals)
stopifnot(
  "a tiny p-value must not collapse to exactly 0 (digits = NA, not digits = 6)" = min_pval > 0
)
cat(sprintf(
  "enrichment: %d result collections, min PValue observed = %.15g\n",
  length(out$results), min_pval
))

# --- ora fixture -------------------------------------------------------------
tmp_in2 <- tempfile(fileext = ".json")
tmp_out2 <- tempfile(fileext = ".json")
payload2 <- fromJSON("tests/fixtures/ora_input.json", simplifyVector = FALSE)
payload2$jobId <- "test-job-ora"
write_json(payload2, tmp_in2, auto_unbox = TRUE)
run_worker(tmp_in2, tmp_out2)
out2 <- fromJSON(tmp_out2, simplifyVector = FALSE)
check_envelope(out2, "ora")
stopifnot("jobId not preserved through the envelope" = identical(out2$jobId, "test-job-ora"))
cat(sprintf("ora: %d result collections\n", length(out2$results)))

# --- unsupported mode exits non-zero with a clear message --------------------
tmp_bad_in <- tempfile(fileext = ".json")
tmp_bad_out <- tempfile(fileext = ".json")
write_json(list(mode = "bogus", jobId = "x"), tmp_bad_in, auto_unbox = TRUE)
stderr_lines <- system2("Rscript", c("worker.R", tmp_bad_in, tmp_bad_out), stderr = TRUE)
bad_status <- attr(stderr_lines, "status")
stopifnot(
  "unsupported mode must exit non-zero" = !is.null(bad_status) && bad_status != 0,
  "stderr must name the unsupported mode, not a stack trace" =
    any(grepl("Unsupported mode: bogus", stderr_lines, fixed = TRUE))
)
cat("unsupported mode: exits", bad_status, "with:", stderr_lines[1], "\n")

# --- 1e-12 precision round-trip using worker.R's exact write_json options ----
precise_path <- tempfile(fileext = ".json")
write_json(list(value = 1e-12), precise_path, auto_unbox = TRUE, digits = NA, na = "null")
round_tripped <- fromJSON(precise_path)
stopifnot(
  "1e-12 must round-trip exactly under digits = NA" =
    isTRUE(all.equal(round_tripped$value, 1e-12)) && round_tripped$value != 0
)
cat("1e-12 round-trip: wrote 1e-12, read back", format(round_tripped$value, scientific = TRUE), "\n")

# --- NA / NaN / Inf -> JSON null, verified directly (not assumed) ------------
edge_df <- data.frame(x = c(NA_real_, NaN, Inf, -Inf, 1e-12))
edge_rows <- lapply(seq_len(nrow(edge_df)), function(i) as.list(edge_df[i, , drop = FALSE]))
edge_path <- tempfile(fileext = ".json")
write_json(list(rows = edge_rows), edge_path, auto_unbox = TRUE, digits = NA, na = "null")
edge_json <- fromJSON(edge_path, simplifyVector = FALSE)
edge_values <- lapply(edge_json$rows, function(r) r$x)
stopifnot(
  "NA must serialize as JSON null" = is.null(edge_values[[1]]),
  "NaN must serialize as JSON null" = is.null(edge_values[[2]]),
  "Inf must serialize as JSON null" = is.null(edge_values[[3]]),
  "-Inf must serialize as JSON null" = is.null(edge_values[[4]]),
  "1e-12 must still round-trip in the same row set" = isTRUE(all.equal(edge_values[[5]], 1e-12))
)
cat("NA/NaN/Inf/-Inf all serialized as null; 1e-12 in the same batch stayed intact.\n")

# --- issue #64: matched/unmatched reporting, and the documented no-match failure ---------
# TaxSEA silently drops any name absent from its bundled NCBI_ids mapping, so a run of
# genus-only or MetaPhlAn s__-prefixed names used to come back "completed" with zero rows
# everywhere and no warning at all. Both halves are checked: the count on a partial match,
# and the hard failure when nothing matches.

check_input_report <- function(out, expected_submitted) {
  rep <- out$taxsea$input
  stopifnot(
    "taxsea.input missing from the envelope" = !is.null(rep),
    "taxsea.input.submitted wrong" = identical(as.integer(rep$submitted), as.integer(expected_submitted)),
    "taxsea.input.matched must be numeric" = is.numeric(rep$matched),
    "taxsea.input.matched cannot exceed submitted" = rep$matched <= rep$submitted,
    "taxsea.input.unmatched must be a list" = is.list(rep$unmatched),
    "unmatched count must equal submitted - matched (when not truncated)" =
      isTRUE(rep$unmatchedTruncated) || length(rep$unmatched) == rep$submitted - rep$matched
  )
  rep
}

# Two real names plus two TaxSEA cannot resolve -- one nonsense, one s__-prefixed (the
# MetaPhlAn convention named in issue #64).
tmp_partial_in <- tempfile(fileext = ".json")
tmp_partial_out <- tempfile(fileext = ".json")
write_json(
  list(
    jobId = "test-partial",
    mode = "ora",
    taxa = c(
      "Bifidobacterium_longum",
      "Bacteroides_thetaiotaomicron",
      "Blortococcus_fakeus",
      "s__Escherichia_coli"
    )
  ),
  tmp_partial_in,
  auto_unbox = TRUE
)
run_worker(tmp_partial_in, tmp_partial_out)
partial <- fromJSON(tmp_partial_out, simplifyVector = FALSE)
rep <- check_input_report(partial, 4)
stopifnot(
  "the two resolvable names should have matched" = rep$matched == 2,
  "s__-prefixed name must be reported as unmatched" =
    "s__Escherichia_coli" %in% unlist(rep$unmatched)
)
cat(sprintf("input report: %d/%d matched, %d reported unmatched\n",
            rep$matched, rep$submitted, length(rep$unmatched)))

# Nothing matches -> must fail with the string docs/api.md 6 documents, not return an
# empty "completed" envelope.
tmp_none_in <- tempfile(fileext = ".json")
tmp_none_out <- tempfile(fileext = ".json")
write_json(
  list(jobId = "test-none", mode = "ora",
       taxa = c("s__Bifidobacterium_longum", "Blortococcus_fakeus")),
  tmp_none_in,
  auto_unbox = TRUE
)
none_lines <- system2("Rscript", c("worker.R", tmp_none_in, tmp_none_out), stderr = TRUE)
none_status <- attr(none_lines, "status")
stopifnot(
  "an all-unmatched run must exit non-zero rather than complete empty" =
    !is.null(none_status) && none_status != 0,
  "stderr must carry the failure string documented in docs/api.md" =
    any(grepl("No input taxa matched the TaxSEA reference database", none_lines, fixed = TRUE))
)
cat("all-unmatched input fails with the documented message\n")

cat("All worker.R tests passed.\n")
