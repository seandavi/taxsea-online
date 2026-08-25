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

cat("All worker.R tests passed.\n")
