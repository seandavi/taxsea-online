# TaxSEA-online infrastructure

Provisioned in M6 (issue #19). Covers the R2 bucket, its lifecycle policy, every credential
the project uses, and the Cloudflare API token permissions `wrangler deploy` needs. See
`PLAN.md` §5 for the design rationale and `docs/api.md` for how these pieces are used at
request time.

## 1. R2 bucket

**`taxsea-jobs`** — created via the Cloudflare API (`POST /accounts/{account_id}/r2/buckets`),
account `55bf7202fe14474e57a300f56a652f64`.

- **Private, no custom domain.** Verified via the R2 API:
  - `GET /accounts/{account_id}/r2/buckets/taxsea-jobs/domains/managed` → `"enabled": false`
    (the `pub-*.r2.dev` managed public domain is off).
  - `GET /accounts/{account_id}/r2/buckets/taxsea-jobs/domains/custom` → `"domains": []`.
  - Results are only ever served through the Worker's `/api/jobs/:jobId/result` endpoint,
    which proxies from R2 through the `JobCoordinatorDO`'s native binding (`docs/api.md` §1,
    §4). Nothing in this project should ever enable a managed or custom domain on this
    bucket — doing so would make anonymous job output world-readable by key guessing.
- **Access is exclusively the Worker's native `R2Bucket` binding** (`[[r2_buckets]]` in
  `edge/wrangler.toml`, binding name `TAXSEA_BUCKET`). No R2 API token, access key, or
  S3-compatible credential is used or needed by this project — the `cdsci-r2-*` secrets in
  Secret Manager are unrelated to this project and must not be added here.
- **Lifecycle policy**, set via `PUT /accounts/{account_id}/r2/buckets/taxsea-jobs/lifecycle`:

  ```json
  {
    "rules": [
      {
        "id": "Default Multipart Abort Rule",
        "enabled": true,
        "conditions": {},
        "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
      },
      {
        "id": "expire-jobs-7d",
        "enabled": true,
        "conditions": { "prefix": "jobs/" },
        "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
      }
    ]
  }
  ```

  - `expire-jobs-7d` deletes everything under `jobs/` (`jobs/{jobId}/input.json` and
    `jobs/{jobId}/output.json`, per `docs/api.md` §4) 7 days (604800 seconds) after it was
    written. **Rationale:** submissions are anonymous, unauthenticated, and have no account
    to retain data against — there is no product reason to keep a completed job's input or
    output past the window a user would plausibly still be looking at it, and keeping it
    longer only accumulates unbounded storage cost for a public, free-to-use endpoint.
  - `Default Multipart Abort Rule` is the bucket's built-in default (aborts stale incomplete
    multipart uploads after 7 days). The R2 lifecycle `PUT` endpoint replaces the *entire*
    rule set, not just the rules you name, so this rule is included explicitly in the payload
    above to avoid silently deleting it.
  - No R2 write access is exercised via `wrangler.toml` `preview_bucket_name` here — the
    `taxsea-jobs-preview` bucket wrangler.toml references for `wrangler dev` is out of scope
    for this issue and is provisioned as needed when local/preview dev is set up.

## 2. Secrets (GCP Secret Manager, project `cdsci-infra`)

All credentials live in Secret Manager only — there is no GCP compute or GCP deploy identity
in this architecture (PLAN.md §5). Naming convention:
`<scope>-<subject>-<credential-type>[-<qualifier>]`, scope `taxsea` for this project.

| Secret | Status | Consumed by | Env var / binding | Read command |
|---|---|---|---|---|
| `cdsci-cloudflare-api-token` | Reused, not recreated | General-purpose CF token (Tofu / ops) — used here only to provision the R2 bucket and lifecycle rule in this issue, not by the running application | n/a (provisioning-time only) | `gcloud secrets versions access latest --secret=cdsci-cloudflare-api-token --project=cdsci-infra` |
| `cdsci-cloudflare-workers-token` | Reused, not recreated | GitHub Actions `deploy.yml` (issue #20) — runs `wrangler deploy` for the Worker, `JobCoordinatorDO`, the compute container image, and the built SPA, all in one deploy | `CLOUDFLARE_API_TOKEN` in the deploy workflow's environment | `gcloud secrets versions access latest --secret=cdsci-cloudflare-workers-token --project=cdsci-infra` |
| `taxsea-worker-shared-secret-service-token` | **New**, created in this issue | Worker secret `WORKER_SHARED_SECRET`, forwarded to the compute container via `JobCoordinatorDO`'s `envVars` (`docs/api.md` §2: `Authorization: Bearer <WORKER_SHARED_SECRET>` on the internal `POST /run` call) | `WORKER_SHARED_SECRET` (Worker secret, set with `wrangler secret put`) and the container's own env var of the same name | `gcloud secrets versions access latest --secret=taxsea-worker-shared-secret-service-token --project=cdsci-infra` |

No R2 credentials exist for this project — see §1.

### `taxsea-worker-shared-secret-service-token`

- Generated with `openssl rand -base64 32` — 32 raw bytes (256 bits) of CSPRNG output,
  base64-encoded to 44 characters. Verified by decoding the stored value and counting raw
  bytes (`gcloud secrets versions access latest ... | base64 -d | wc -c` → `32`) without ever
  printing the value itself.
- Labels: `type=service-token`, `subject=worker`, `scope=taxsea`, `managed-by=manual`.
- Annotations: `purpose`, `consumed-by`, `rotated=2026-08-24` — per the labels/annotations
  convention in `monode/infrastructure/terraform/README.md` § "Secrets — naming convention".

**Rotation procedure:** this is the only credential the application code handles, and it
exists in exactly two places — GCP Secret Manager (source of truth) and the Worker's own
secret store. Rotating it is a single atomic step from the application's point of view:

```bash
NEW=$(openssl rand -base64 32)
printf '%s' "$NEW" | gcloud secrets versions add taxsea-worker-shared-secret-service-token \
  --data-file=- --project=cdsci-infra
printf '%s' "$NEW" | npx wrangler secret put WORKER_SHARED_SECRET --config edge/wrangler.toml
unset NEW
```

Then redeploy (`wrangler deploy`). Because the container never has its own independent copy
of the secret — it receives the current value from `JobCoordinatorDO`'s `envVars` fresh on
every container start — a `wrangler secret put` followed by a redeploy rotates both the
Worker side and the container side atomically. There is no window where the two sides hold
different values, because the container-side value is never stored anywhere; it is only ever
handed to the container process at start time.

## 3. Cloudflare API token permissions for `wrangler deploy` (container/registry push)

**Status: partially verified; full verification is deferred to the first real `wrangler
deploy` in issue #20.**

What was checked in this issue, using `cdsci-cloudflare-workers-token` (the token
`deploy.yml` will use, per its Secret Manager label `purpose=workers-deploy`):

- `GET /user/tokens/verify` returns `{"success": false, "errors": [{"code": 1000, "message":
  "Invalid API Token"}]}` for **both** `cdsci-cloudflare-workers-token` and
  `cdsci-cloudflare-api-token`. This is expected and not a sign of a broken token: `/user/tokens/verify`
  only introspects *user*-owned tokens (prefix `cfut_`); both of these are *account*-owned
  tokens (prefix `cfat_`, per the `cf-token-type` annotation convention), and Cloudflare does
  not expose an equivalent "verify this account token" endpoint to the token itself. The same
  token authenticates real API calls successfully (see below), confirming it is valid.
- `GET /accounts/{account_id}/workers/scripts` (list Workers scripts) succeeded with
  `cdsci-cloudflare-workers-token` — confirms at least **Workers Scripts: Read**. Actually
  *editing* a script (deploying) was not exercised, to avoid touching another project's live
  Worker with a shared token during this provisioning step.
- `GET /accounts/{account_id}/r2/buckets` (list R2 buckets) succeeded with the same token —
  confirms at least **R2 Storage: Read**.
- No standalone "Containers" or "container registry push" permission group exists in
  Cloudflare's current API token permission documentation
  (`developers.cloudflare.com/fundamentals/api/reference/permissions/`, checked in this
  issue). Container image build-and-push during `wrangler deploy` is described purely as part
  of the `wrangler deploy` flow (`developers.cloudflare.com/containers/platform-details/image-management/`)
  with no separate token scope called out — the working assumption is that it rides on
  **Workers Scripts: Edit**, since pushing to `registry.cloudflare.com` is presented as an
  integral, non-optional step of deploying a Worker that has a `[[containers]]` block, not a
  separately-gated capability.
- Introspecting the token's own full permission policy (`GET
  /user/tokens/permission_groups` and its account-token equivalent) requires the token itself
  to carry **API Tokens Read**, which a deploy-purpose token should not and does not have —
  so the exact permission-group list could not be enumerated from inside this issue without
  granting the token a permission it has no legitimate reason to hold.

**What to do if the first `wrangler deploy` (issue #20) fails on the image push step:**

1. Expect the failure to surface as an authentication/authorization error from
   `registry.cloudflare.com` during the "push" phase of `wrangler deploy` (after the Worker
   script itself uploads successfully) — for example a 401/403 from the registry push step,
   distinct from a Docker build failure.
2. Go to the Cloudflare dashboard → **Manage Account** → **Account API Tokens** (this is an
   account-owned token, not a user token) → find the token named for `workers-deploy` →
   **Edit**.
3. Confirm the token's policy includes, at minimum: **Workers Scripts: Edit**, **Workers R2
   Storage: Edit** (or the native binding equivalent — R2 access here is via binding, but the
   deploy step itself needs permission to attach the binding), and **Account Settings: Read**.
   There is no separate "Containers" toggle to add as of this writing; if Cloudflare has since
   introduced one, add it here.
4. Re-run `wrangler deploy`. If it still fails identically, the blocker is more likely the
   Workers Paid plan/Containers entitlement (see §4) than the token.

## 4. Workers Paid plan (Cloudflare Containers requirement)

Cloudflare Containers requires the Workers Paid plan
(`developers.cloudflare.com/containers/`: "Available on Workers Paid plan"). **This is
already satisfied on this account** — confirmed as a precondition for this project going
into M6, not an open item. It is recorded here so a future reader does not treat plan
upgrade as a pending blocker; the only genuinely open item from this issue is the
container/registry token-permission check in §3, which needs a real deploy to fully confirm.

## 5. Container has no cloud access — do not "fix" this by adding credentials

The compute container (`/worker/Dockerfile`, deployed via the `[[containers]]` block in
`edge/wrangler.toml`) runs with **`enableInternet = false`** and is handed **no storage
credentials of any kind**. Every R2 read and write is performed by `JobCoordinatorDO` itself,
through its native `R2Bucket` binding; the container receives and returns data only in the
body of the internal `POST /run` call (`docs/api.md` §2). This is deliberate (PLAN.md §2.6):

- The container is not internet-reachable, so it has no way to exfiltrate data even if
  compromised by adversarial R input.
- If a future feature seems to need the container to talk to storage directly, **the fix is
  to have the DO do the I/O and pass the result by value to the container**, not to add an R2
  access key, service-account credential, or `enableInternet = true` to the container. Adding
  credentials to the container reopens exactly the attack surface this design avoids.

## 6. No secret values in this repository

Every command above that reads a secret value pipes it directly into the next command
(`gcloud secrets versions add`, `wrangler secret put`) or discards it — none is echoed to a
terminal, committed, or written to `wrangler.toml` or any workflow file. `wrangler.toml`'s
only reference to the secret is the *name* `WORKER_SHARED_SECRET`, set out-of-band with
`wrangler secret put`.
