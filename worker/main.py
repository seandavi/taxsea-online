"""FastAPI entrypoint for the TaxSEA compute container.

Stub only. This issue (#3) delivers the container image; the real POST /run handler
that shells out to worker.R is implemented in #5, and GET /health in #6. This file exists
solely so `uvicorn main:app` has something to serve and the container starts cleanly.
"""

from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok"}
