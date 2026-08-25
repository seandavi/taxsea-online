"""FastAPI wrapper around worker.R: POST /run, called synchronously by the DO.

No cloud SDKs, no credentials, no network egress here on purpose (see docs/api.md §2) --
the DO owns R2 and passes payloads by value in the request/response bodies of this one
internal call. This process's only job is: validate the request, write it to a temp file,
run `Rscript worker.R <in> <out>` with a timeout, and return the output.json envelope
worker.R wrote.

--workers 1 in the Dockerfile's CMD (issue #3) is load-bearing here, not incidental: R
holds TaxSEA's full taxon database in memory for the lifetime of the Rscript subprocess,
and Cloudflare Containers already gives one container instance per job, so concurrency
within a single uvicorn process is not this file's problem to solve.
"""

import hmac
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, model_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("taxsea-worker")

# --- Config: read once at import, fail fast if a required var is missing -----------------
WORKER_SHARED_SECRET = os.environ["WORKER_SHARED_SECRET"]
RSCRIPT_TIMEOUT_SECONDS = int(os.environ.get("RSCRIPT_TIMEOUT_SECONDS", "240"))

WORKER_R_PATH = Path(__file__).parent / "worker.R"

# Same UUIDv4 pattern as docs/api.md §4. jobId is never used as a filesystem or storage
# path here (the container has no R2 access at all) -- this regex is just request
# validation, matching the contract's shape.
UUID_V4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

MAX_ERROR_LEN = 2000
_ABS_PATH_RE = re.compile(r"/[^\s'\"]+")


class RunRequest(BaseModel):
    jobId: str
    mode: Literal["enrichment", "ora"]
    ranks: dict[str, float] | None = None
    taxa: list[str] | None = None
    options: dict | None = None

    @model_validator(mode="after")
    def _check(self) -> "RunRequest":
        if not UUID_V4_RE.match(self.jobId):
            raise ValueError("jobId must be a UUIDv4")
        if self.mode == "enrichment" and self.ranks is None:
            raise ValueError("mode=enrichment requires ranks")
        if self.mode == "ora" and self.taxa is None:
            raise ValueError("mode=ora requires taxa")
        return self


app = FastAPI()


@app.exception_handler(RequestValidationError)
async def _malformed_body(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Request-level problem (bad shape/types), not a job-level failure -- 400, not 200.
    return JSONResponse(status_code=400, content={"error": "invalid_request"})


def _sanitize_error(text: str) -> str:
    """Truncate to 2000 chars and strip absolute paths; R errors can echo input content."""
    return _ABS_PATH_RE.sub("<path>", text)[:MAX_ERROR_LEN]


def _check_taxsea() -> tuple[bool, str]:
    """Verify R + TaxSEA are loadable and get the package version. Called once at import
    (below) and cached in _TAXSEA_STATUS -- GET /health must never spawn its own Rscript
    process, or the health check becomes the most expensive endpoint in the service."""
    try:
        proc = subprocess.run(
            [
                "Rscript",
                "-e",
                'library(TaxSEA); cat(as.character(utils::packageVersion("TaxSEA")))',
            ],
            capture_output=True,
            text=True,
            timeout=RSCRIPT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return False, "Rscript timed out loading TaxSEA"
    if proc.returncode != 0:
        return False, _sanitize_error(
            proc.stderr.strip() or "Rscript exited nonzero loading TaxSEA"
        )
    return True, proc.stdout.strip()


# Startup check, not a per-request probe -- see _check_taxsea's docstring.
_TAXSEA_STATUS = _check_taxsea()


def _check_auth(authorization: str | None) -> None:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.removeprefix("Bearer ")
    # hmac.compare_digest, not `!=`: constant-time, and the 401 below never reveals
    # whether the header was missing, malformed, or just the wrong secret.
    if not hmac.compare_digest(token, WORKER_SHARED_SECRET):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _failure(job_id: str, execution_time_ms: int, error: str) -> dict:
    return {
        "jobId": job_id,
        "status": "failed",
        "executionTimeMs": execution_time_ms,
        "error": error,
    }


@app.post("/run")
def run(payload: RunRequest, authorization: str | None = Header(default=None)) -> dict:
    _check_auth(authorization)
    job_id = payload.jobId

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "input.json"
        output_path = Path(tmpdir) / "output.json"
        input_path.write_text(payload.model_dump_json(exclude_none=True))

        start = time.monotonic()
        try:
            proc = subprocess.run(
                ["Rscript", str(WORKER_R_PATH), str(input_path), str(output_path)],
                capture_output=True,
                text=True,
                timeout=RSCRIPT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            execution_time_ms = int((time.monotonic() - start) * 1000)
            logger.error("jobId=%s Rscript timed out after %ss", job_id, RSCRIPT_TIMEOUT_SECONDS)
            return _failure(
                job_id,
                execution_time_ms,
                _sanitize_error(f"Analysis timed out after {RSCRIPT_TIMEOUT_SECONDS}s"),
            )

        execution_time_ms = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            logger.error("jobId=%s Rscript exited %s", job_id, proc.returncode)
            return _failure(
                job_id,
                execution_time_ms,
                _sanitize_error(
                    f"Rscript exited with status {proc.returncode}: {proc.stderr or '(no stderr)'}"
                ),
            )

        try:
            output = json.loads(output_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            logger.error("jobId=%s output file missing or unparseable: %s", job_id, exc)
            return _failure(
                job_id,
                execution_time_ms,
                _sanitize_error(f"Worker output file missing or unparseable: {exc}"),
            )

    logger.info("jobId=%s completed in %sms", job_id, execution_time_ms)
    return output


@app.get("/health")
def health() -> PlainTextResponse:
    # No auth: pingEndpoint on the Container class must reach this before the container
    # is considered ready, and it's not internet-reachable regardless (see issue #6).
    ok, info = _TAXSEA_STATUS
    if ok:
        return PlainTextResponse(f"Healthy: TaxSEA {info}")
    return PlainTextResponse(f"Unhealthy: TaxSEA not loadable: {info}", status_code=503)
