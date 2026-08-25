#!/usr/bin/env bash
# Asserts that the `taxsea-jobs` R2 bucket still has its 7-day expiry rule (issue #70).
#
# The rule is set once, by hand, via the lifecycle API (docs/infra.md §1) -- nothing in the
# deploy path re-applies it, and the API *replaces the entire rule set* on every write. So any
# future lifecycle change that forgets to re-send this rule silently drops it, and job inputs
# and outputs start accumulating forever. Nothing else would notice: the app keeps working
# perfectly, which is exactly why this needs an assertion rather than a code review habit.
#
# Usage: CLOUDFLARE_API_TOKEN=... ./scripts/check-r2-lifecycle.sh
set -euo pipefail

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-55bf7202fe14474e57a300f56a652f64}"
BUCKET="${R2_BUCKET:-taxsea-jobs}"
EXPECTED_PREFIX="jobs/"
EXPECTED_MAX_AGE=604800 # 7 days, per docs/infra.md §1

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"

response=$(curl -sS \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/lifecycle")

if [ "$(printf '%s' "$response" | jq -r '.success')" != "true" ]; then
  # Distinguished from "rule missing" on purpose: an expired or under-scoped token is an
  # infrastructure problem to fix, not evidence that retention is broken.
  echo "FAIL: could not read the lifecycle policy for '${BUCKET}'." >&2
  echo "      This is an API/permissions failure, NOT proof the rule is missing." >&2
  echo "      The deploy token needs 'R2 Storage: Read' (docs/infra.md §3)." >&2
  printf '%s\n' "$response" | jq -r '.errors // .' >&2
  exit 2
fi

matching=$(printf '%s' "$response" | jq --arg p "$EXPECTED_PREFIX" --argjson a "$EXPECTED_MAX_AGE" '
  [ .result.rules[]?
    | select(.enabled == true)
    | select(.conditions.prefix == $p)
    | select(.deleteObjectsTransition.condition.maxAge == $a)
  ] | length')

if [ "$matching" -lt 1 ]; then
  echo "FAIL: '${BUCKET}' has no enabled rule deleting '${EXPECTED_PREFIX}' after ${EXPECTED_MAX_AGE}s." >&2
  echo "      Job inputs and outputs will accumulate indefinitely." >&2
  echo "      Re-apply the policy in docs/infra.md §1 -- and note the lifecycle PUT replaces" >&2
  echo "      the whole rule set, so re-send 'Default Multipart Abort Rule' with it." >&2
  echo "Current rules:" >&2
  printf '%s\n' "$response" | jq -r '.result.rules // []' >&2
  exit 1
fi

echo "OK: '${BUCKET}' expires '${EXPECTED_PREFIX}' after ${EXPECTED_MAX_AGE}s (7 days)."
