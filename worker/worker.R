# Rscript entrypoint invoked by main.py's POST /run handler.
#
# Stub only. This issue (#3) delivers the container image; the real enrichment/ORA logic and
# JSON envelope are implemented in #4. This file exists solely to prove the R runtime and its
# packages are wired up correctly -- it is a no-op that exits 0.
cat("worker.R stub -- implemented in issue #4\n")
