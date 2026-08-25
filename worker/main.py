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

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("taxsea-worker")


def _log(level: int, msg: str, **fields: object) -> None:
    """Structured single-line JSON logging (issue #22): builds the JSON line directly and
    hands it to stdlib `logging` as the whole message, with `format="%(message)s"` above so
    nothing gets wrapped or double-escaped -- no logging framework, just stdlib.

    Never pass user-supplied content (taxa, ranks, request/response bodies) in `fields` --
    log counts/sizes instead. The one deliberate exception is sanitized R stderr on failure
    (see `_sanitize_error`), which the caller must sanitize before passing here.
    """
    logger.log(
        level,
        json.dumps(
            {
                "ts": int(time.time() * 1000),
                "level": logging.getLevelName(level).lower(),
                "component": "worker",
                "msg": msg,
                **fields,
            }
        ),
    )


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
    """Truncate to 2000 chars, strip absolute paths, and redact the shared secret.

    R errors can echo input content or filesystem paths. The secret redaction is
    defense-in-depth for a subtler leak: the Rscript subprocess inherits this process's
    full environment (including WORKER_SHARED_SECRET) by default, so a buggy or malicious
    worker.R that dumps its environment on error could otherwise put the secret into
    stderr -- which this function's caller logs on failure (issue #22).
    """
    text = text.replace(WORKER_SHARED_SECRET, "[redacted]")
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
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "Rscript timed out loading TaxSEA"
    except OSError as exc:
        # The Rscript binary itself isn't on PATH (e.g. a plain Python test/lint
        # environment with no R installed, as opposed to the container image, which
        # always has it) -- a missing interpreter is squarely "R/TaxSEA not loadable",
        # not a reason to crash the whole app at import time.
        return False, f"Rscript not found: {exc}"
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
    # Counts, never the taxa/ranks themselves (docs/api.md #6, issue #22).
    _log(
        logging.INFO,
        "job received",
        jobId=job_id,
        mode=payload.mode,
        **({"taxaCount": len(payload.taxa)} if payload.taxa is not None else {}),
        **({"ranksCount": len(payload.ranks)} if payload.ranks is not None else {}),
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "input.json"
        output_path = Path(tmpdir) / "output.json"
        input_path.write_text(payload.model_dump_json(exclude_none=True))

        start = time.monotonic()
        _log(logging.INFO, "Rscript started", jobId=job_id)
        try:
            proc = subprocess.run(
                ["Rscript", str(WORKER_R_PATH), str(input_path), str(output_path)],
                capture_output=True,
                text=True,
                timeout=RSCRIPT_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            execution_time_ms = int((time.monotonic() - start) * 1000)
            _log(
                logging.ERROR,
                "Rscript exited: timed out",
                jobId=job_id,
                durationMs=execution_time_ms,
                timeoutSeconds=RSCRIPT_TIMEOUT_SECONDS,
            )
            return _failure(
                job_id,
                execution_time_ms,
                _sanitize_error(f"Analysis timed out after {RSCRIPT_TIMEOUT_SECONDS}s"),
            )

        execution_time_ms = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            # Truncated to 2000 chars with absolute paths stripped by _sanitize_error, reused
            # from the client-facing error below (docs/api.md #6, issue #22).
            _log(
                logging.ERROR,
                "Rscript exited",
                jobId=job_id,
                exitCode=proc.returncode,
                durationMs=execution_time_ms,
                stderr=_sanitize_error(proc.stderr or "(no stderr)"),
            )
            return _failure(
                job_id,
                execution_time_ms,
                _sanitize_error(
                    f"Rscript exited with status {proc.returncode}: {proc.stderr or '(no stderr)'}"
                ),
            )

        _log(
            logging.INFO,
            "Rscript exited",
            jobId=job_id,
            exitCode=proc.returncode,
            durationMs=execution_time_ms,
        )

        try:
            raw_output = output_path.read_text()
            output = json.loads(raw_output)
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            _log(
                logging.ERROR,
                "result returned: output file missing or unparseable",
                jobId=job_id,
                error=str(exc),
            )
            return _failure(
                job_id,
                execution_time_ms,
                _sanitize_error(f"Worker output file missing or unparseable: {exc}"),
            )

    _log(
        logging.INFO,
        "result returned",
        jobId=job_id,
        status=output.get("status") if isinstance(output, dict) else None,
        executionTimeMs=execution_time_ms,
        resultBytes=len(raw_output),
    )
    return output


@app.get("/health")
def health() -> PlainTextResponse:
    # No auth: pingEndpoint on the Container class must reach this before the container
    # is considered ready, and it's not internet-reachable regardless (see issue #6).
    ok, info = _TAXSEA_STATUS
    if ok:
        return PlainTextResponse(f"Healthy: TaxSEA {info}")
    return PlainTextResponse(f"Unhealthy: TaxSEA not loadable: {info}", status_code=503)
