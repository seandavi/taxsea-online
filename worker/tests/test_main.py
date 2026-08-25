"""FastAPI-level tests for main.py: auth, request validation, and the subprocess
error-handling paths, with the Rscript subprocess call mocked out (no real R/TaxSEA
needed -- see /worker/tests/test_worker_r.R for the real-R-process test instead).
"""

import json
import subprocess

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)

JOB_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
AUTH = {"Authorization": f"Bearer {main.WORKER_SHARED_SECRET}"}
BODY = {"jobId": JOB_ID, "mode": "ora", "taxa": ["Bifidobacterium_longum"]}


def _fake_run_writing(output_body: dict):
    """Fake subprocess.run that writes output_body to the <out> path it's given, like
    a real worker.R invocation would, and returns a successful CompletedProcess."""

    def _fake(cmd, **kwargs):
        output_path = cmd[3]
        with open(output_path, "w") as f:
            json.dump(output_body, f)
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    return _fake


def test_missing_auth_header_401():
    resp = client.post("/run", json=BODY)
    assert resp.status_code == 401


def test_wrong_secret_401():
    resp = client.post("/run", json=BODY, headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401


def test_malformed_body_400():
    resp = client.post("/run", json={"mode": "enrichment"}, headers=AUTH)
    assert resp.status_code == 400


def test_bad_job_id_400():
    resp = client.post("/run", json={**BODY, "jobId": "not-a-uuid"}, headers=AUTH)
    assert resp.status_code == 400


def test_happy_path(monkeypatch):
    envelope = {
        "jobId": JOB_ID,
        "status": "completed",
        "executionTimeMs": 42,
        "taxsea": {"packageVersion": "1.4.0", "mode": "ora", "params": {}},
        "results": {},
    }
    monkeypatch.setattr(main.subprocess, "run", _fake_run_writing(envelope))

    resp = client.post("/run", json=BODY, headers=AUTH)

    assert resp.status_code == 200
    assert resp.json() == envelope


def test_rscript_timeout(monkeypatch):
    def _fake(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    monkeypatch.setattr(main.subprocess, "run", _fake)

    resp = client.post("/run", json=BODY, headers=AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["jobId"] == JOB_ID
    assert "timed out" in body["error"]
    assert isinstance(body["executionTimeMs"], int)


def test_rscript_nonzero_exit(monkeypatch):
    def _fake(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd, returncode=1, stdout="", stderr="Error in /app/worker.R: bad input /tmp/secret"
        )

    monkeypatch.setattr(main.subprocess, "run", _fake)

    resp = client.post("/run", json=BODY, headers=AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert "/app/worker.R" not in body["error"]
    assert "/tmp/secret" not in body["error"]


def test_output_file_missing(monkeypatch):
    def _fake(cmd, **kwargs):
        # exits 0 but never writes the output file
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main.subprocess, "run", _fake)

    resp = client.post("/run", json=BODY, headers=AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert "missing or unparseable" in body["error"]


def test_error_strings_are_distinct(monkeypatch):
    """The three failure modes must not share an error message."""
    errors = set()

    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda cmd, **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired(cmd, 1)),
    )
    errors.add(client.post("/run", json=BODY, headers=AUTH).json()["error"])

    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda cmd, **kwargs: subprocess.CompletedProcess(
            cmd, returncode=1, stdout="", stderr="boom"
        ),
    )
    errors.add(client.post("/run", json=BODY, headers=AUTH).json()["error"])

    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr=""),
    )
    errors.add(client.post("/run", json=BODY, headers=AUTH).json()["error"])

    assert len(errors) == 3
