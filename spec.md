# Engineering Technical Specification: TaxSEA Microservice Architecture

## 1. Overview & Objectives

This specification outlines the implementation of an asynchronous taxon-set enrichment service using the Bioconductor package **TaxSEA**.

### Architecture Pattern

* **Frontend:** React SPA (submits payloads, establishes WebSockets for real-time progress, renders results).
* **Coordinator:** Cloudflare Worker + Durable Objects (DO) for job state coordination, timeout management (Alarms), and WebSocket broadcasting.
* **Storage:** Cloudflare R2 for zero-egress persistence of input matrices and enriched JSON results.
* **Compute Worker:** Containerized service (FastAPI sidecar executing native `Rscript`) scalable on on-demand container infrastructure (Cloud Run, Fly.io, or AWS ECS/Fargate).

---

## 2. System Flow

```text
[ React Frontend ]
  │
  ├── 1. POST /api/jobs (Submit Taxa Data) ───────────► [ Cloudflare Worker / Router ]
  │                                                               │
  │   ┌───────────────────────────────────────────────────────────┘
  │   ▼
  │ [ Durable Object: JobCoordinatorDO ]
  │   ├── 2. Writes input payload ────────────────────► [ Cloudflare R2 ]
  │   ├── 3. Sets timeout alarm (e.g., +120s)
  │   └── 4. Dispatches POST /run ────────────────────► [ R Worker Container ]
  │                                                               │
  ├── 5. Connects wss://api.domain/jobs/:id/ws                     │ (Async Execution)
  │   ◄── Streams { status: "running" }                          │
  │                                                               ├── 6. Reads input.json
  │                                                               ├── 7. Runs TaxSEA via R
  │                                                               ├── 8. Writes output.json ──► [ R2 ]
  │                                                               └── 9. POST /api/jobs/:id/complete
  │                                                                        │
  │   ┌────────────────────────────────────────────────────────────────────┘
  │   ▼
  │ [ Durable Object: JobCoordinatorDO ]
  │   ├── 10. Cancels timeout alarm
  │   └── 11. Broadcasts { status: "completed", resultUrl: "..." }
  │
  └── 12. GET output.json via pre-signed URL / CDN ◄─── [ Cloudflare R2 ]

```

---

## 3. Storage & Data Contracts

### 3.1 R2 Bucket Structure

```text
taxsea-jobs/
└── jobs/
    └── {jobId}/
        ├── input.json
        └── output.json

```

### 3.2 Input Data Contract (`input.json`)

The endpoint must accept both **Enrichment Mode** (named rank vector) and **ORA Mode** (taxa string array).

```json
{
  "mode": "enrichment", 
  "ranks": {
    "Bifidobacterium_longum": 2.45,
    "Bacteroides_thetaiotaomicron": 1.12,
    "Ruminococcus_bromii": -3.05
  },
  "options": {
    "customDb": null
  }
}

```

### 3.3 Output Data Contract (`output.json`)

Standardized serializable structure matching `TaxSEA` R output:

```json
{
  "jobId": "job_948fca8a",
  "status": "completed",
  "executionTimeMs": 2340,
  "results": {
    "Metabolite_producers": [
      {
        "taxonSetName": "Short Chain Fatty Acids",
        "median_rank": 1.85,
        "pValue": 0.0034,
        "FDR": 0.012,
        "taxaInSet": ["Bifidobacterium_longum", "Bacteroides_thetaiotaomicron"]
      }
    ],
    "Health_associations": [],
    "BugSigDB": []
  }
}

```

---

## 4. Component Implementation Specifications

### Component 1: R Compute Worker Container

#### 4.1 `Dockerfile`

Base image must include R and Bioconductor toolchains.

```dockerfile
FROM rocker/r-ver:4.3.2

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Bioconductor & TaxSEA
RUN R -e "install.packages('BiocManager', repos='https://cloud.r-project.org')" \
    && R -e "BiocManager::install(c('TaxSEA', 'jsonlite'), ask=FALSE)"

# Install Python sidecar dependencies
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY main.py worker.R ./

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]

```

#### 4.2 `worker.R`

CLI wrapper executing the analysis in an isolated sub-process.

```r
#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(TaxSEA)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) {
  stop("Usage: Rscript worker.R <input_path> <output_path>")
}

input_path  <- args[1]
output_path <- args[2]

payload <- jsonlite::fromJSON(input_path)

if (payload$mode == "enrichment") {
  ranks_vector <- unlist(payload$ranks)
  results <- TaxSEA::TaxSEA(taxon_ranks = ranks_vector)
} else if (payload$mode == "ora") {
  taxa_list <- as.character(payload$taxa)
  results <- TaxSEA::TaxSEA(input_taxa = taxa_list)
} else {
  stop(paste("Unsupported mode:", payload$mode))
}

# Write standard JSON
jsonlite::write_json(results, output_path, auto_unbox = TRUE, digits = 6)

```

#### 4.3 `main.py` (FastAPI Sidecar)

Responsible for fetching from R2, executing `worker.R`, uploading the output, and triggering the webhook callback.

```python
import os
import subprocess
import time
import requests
import boto3
from botocore.config import Config
from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel

app = FastAPI(title="TaxSEA Worker Service")

R2_ENDPOINT = os.environ["R2_ENDPOINT_URL"]
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET_KEY = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET = os.environ["R2_BUCKET_NAME"]
SHARED_SECRET = os.environ["WORKER_SHARED_SECRET"]

s3_client = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY,
    config=Config(signature_version="s3v4"),
)

class RunPayload(BaseModel):
    jobId: str
    inputKey: str
    outputKey: str
    callbackUrl: str
    secret: str

def execute_job(payload: RunPayload):
    job_id = payload.jobId
    in_file = f"/tmp/{job_id}_in.json"
    out_file = f"/tmp/{job_id}_out.json"
    start_time = time.time()

    try:
        # 1. Fetch input from R2
        s3_client.download_file(R2_BUCKET, payload.inputKey, in_file)

        # 2. Run R worker script
        cmd = ["Rscript", "worker.R", in_file, out_file]
        run_res = subprocess.run(cmd, capture_output=True, text=True, check=True)

        # 3. Push output to R2
        s3_client.upload_file(
            out_file, 
            R2_BUCKET, 
            payload.outputKey, 
            ExtraArgs={"ContentType": "application/json"}
        )

        elapsed_ms = int((time.time() - start_time) * 1000)

        # 4. Notify Durable Object via Callback Webhook
        requests.post(
            payload.callbackUrl,
            json={
                "jobId": job_id,
                "status": "completed",
                "executionTimeMs": elapsed_ms,
                "outputKey": payload.outputKey
            },
            headers={"Authorization": f"Bearer {SHARED_SECRET}"},
            timeout=10
        )

    except subprocess.CalledProcessError as e:
        requests.post(
            payload.callbackUrl,
            json={
                "jobId": job_id,
                "status": "failed",
                "error": f"Rscript error: {e.stderr}"
            },
            headers={"Authorization": f"Bearer {SHARED_SECRET}"},
            timeout=10
        )
    except Exception as e:
        requests.post(
            payload.callbackUrl,
            json={
                "jobId": job_id,
                "status": "failed",
                "error": str(e)
            },
            headers={"Authorization": f"Bearer {SHARED_SECRET}"},
            timeout=10
        )
    finally:
        for path in [in_file, out_file]:
            if os.path.exists(path):
                os.remove(path)

@app.post("/run")
def run_taxsea(payload: RunPayload, background_tasks: BackgroundTasks):
    if payload.secret != SHARED_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    background_tasks.add_task(execute_job, payload)
    return {"status": "accepted", "jobId": payload.jobId}

```

---

### Component 2: Cloudflare Worker & Durable Object Coordinator

#### 4.4 `JobCoordinatorDO.ts` (Durable Object)

```typescript
export interface Env {
  TAXSEA_BUCKET: R2Bucket;
  COMPUTE_WORKER_URL: string;
  WORKER_SHARED_SECRET: string;
  APP_DOMAIN: string;
}

interface JobState {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  createdAt: number;
  outputKey?: string;
  error?: string;
}

export class JobCoordinatorDO implements DurableObject {
  state: DurableObjectState;
  env: Env;
  sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade handler
    if (url.pathname.endsWith("/ws")) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      await this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP Dispatch: Start Job
    if (request.method === "POST" && url.pathname.endsWith("/dispatch")) {
      const payload = await request.json<any>();
      return this.handleDispatch(payload);
    }

    // HTTP Webhook: Worker Callback
    if (request.method === "POST" && url.pathname.endsWith("/callback")) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${this.env.WORKER_SHARED_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const data = await request.json<any>();
      return this.handleCallback(data);
    }

    // HTTP State Retrieval
    if (request.method === "GET" && url.pathname.endsWith("/state")) {
      const current = (await this.state.storage.get<JobState>("state")) || { status: "not_found" };
      return Response.json(current);
    }

    return new Response("Not Found", { status: 404 });
  }

  async handleDispatch(payload: any): Promise<Response> {
    const jobId = payload.jobId;
    const inputKey = `jobs/${jobId}/input.json`;
    const outputKey = `jobs/${jobId}/output.json`;

    // 1. Write input to R2
    await this.env.TAXSEA_BUCKET.put(inputKey, JSON.stringify(payload.data));

    // 2. Set State & 120-second timeout Alarm
    const jobState: JobState = { jobId, status: "running", createdAt: Date.now() };
    await this.state.storage.put("state", jobState);
    await this.state.storage.setAlarm(Date.now() + 120_000);

    // 3. Dispatch to Compute Container
    const callbackUrl = `https://${this.env.APP_DOMAIN}/api/jobs/${jobId}/callback`;
    
    fetch(`${this.env.COMPUTE_WORKER_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        inputKey,
        outputKey,
        callbackUrl,
        secret: this.env.WORKER_SHARED_SECRET
      })
    }).catch(err => {
      this.broadcast({ status: "failed", error: "Failed to dispatch compute container." });
    });

    return Response.json({ status: "dispatched", jobId });
  }

  async handleCallback(data: any): Promise<Response> {
    // Clear timeout alarm
    await this.state.storage.deleteAlarm();

    const currentState = (await this.state.storage.get<JobState>("state")) || ({} as JobState);
    currentState.status = data.status;
    currentState.outputKey = data.outputKey;
    currentState.error = data.error;

    await this.state.storage.put("state", currentState);
    this.broadcast(currentState);

    return Response.json({ received: true });
  }

  async alarm() {
    // Triggered if compute fails to reply within 120s
    const currentState = await this.state.storage.get<JobState>("state");
    if (currentState && currentState.status === "running") {
      currentState.status = "timed_out";
      currentState.error = "Analysis timed out after 120 seconds.";
      await this.state.storage.put("state", currentState);
      this.broadcast(currentState);
    }
  }

  private async handleSession(ws: WebSocket) {
    ws.accept();
    this.sessions.add(ws);

    // Send current state upon connection
    const currentState = await this.state.storage.get<JobState>("state");
    if (currentState) {
      ws.send(JSON.stringify(currentState));
    }

    ws.addEventListener("close", () => {
      this.sessions.delete(ws);
    });
  }

  private broadcast(message: any) {
    const payload = JSON.stringify(message);
    for (const ws of this.sessions) {
      try {
        ws.send(payload);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}

```

---

## 5. React Integration Pattern

```tsx
import React, { useEffect, useState } from "react";

interface TaxSEAResults {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  outputKey?: string;
  error?: string;
}

export function useTaxSEAJob(jobId: string | null) {
  const [jobState, setJobState] = useState<TaxSEAResults | null>(null);
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    if (!jobId) return;

    const ws = new WebSocket(`wss://api.yourdomain.com/jobs/${jobId}/ws`);

    ws.onmessage = async (event) => {
      const state: TaxSEAResults = JSON.parse(event.data);
      setJobState(state);

      if (state.status === "completed" && state.outputKey) {
        // Fetch output payload directly from R2 / CDN endpoint
        const res = await fetch(`https://data.yourdomain.com/${state.outputKey}`);
        const json = await res.json();
        setData(json);
      }
    };

    return () => ws.close();
  }, [jobId]);

  return { jobState, data };
}

```

---

## 6. Implementation Checklist & Acceptance Criteria

### Agent Implementation Tasks:

1. **Container (`/worker`):**
* [ ] Implement `Dockerfile` based on `rocker/r-ver:4.3.2`.
* [ ] Add `worker.R` supporting both `enrichment` and `ora` parameters from `TaxSEA`.
* [ ] Implement `main.py` using `FastAPI` with background thread handling for subprocesses and boto3 S3 clients.


2. **Cloudflare Edge (`/edge`):**
* [ ] Configure `wrangler.toml` with bindings for `R2Bucket` and `JobCoordinatorDO`.
* [ ] Implement `JobCoordinatorDO` with WebSocket connections, state storage, and Alarm lifecycle hooks.
* [ ] Add routing in index worker for `/api/jobs` and `/api/jobs/:id/*`.


3. **End-to-End Verification:**
* [ ] Submit sample input (`TaxSEA_test_data` equivalent vector).
* [ ] Verify `input.json` appears in R2.
* [ ] Verify R container starts, processes, and writes `output.json` to R2.
* [ ] Verify WebSocket receives `{ status: "completed" }` notification.
* [ ] Verify intentional timeout/failure invokes error states in the DO alarm.
