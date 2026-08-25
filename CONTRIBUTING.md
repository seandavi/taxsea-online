# Contributing

## Workflow

One issue, one branch, one PR:

1. Pick an open issue (see the milestone/issue breakdown in `PLAN.md` §6).
2. Branch off `main`: `git checkout -b issue-<number>-<short-description>`.
3. Implement only what that issue asks for — no drive-by scope creep into other issues.
4. Open a PR that references the issue (`Closes #<number>`).
5. CI must pass — two workflows, each path-filtered so only the relevant one blocks a given
   PR:
   - **CI (JS)** (`.github/workflows/ci-js.yml`): `edge` and `frontend` jobs, each running
     lint, typecheck, test, and build for that component. Only runs for the component(s)
     whose files actually changed (a `changes` job diffs the PR).
   - **CI (Worker)** (`.github/workflows/ci-worker.yml`), only when `worker/**` changes:
     `lint-test` (ruff + pytest) and `build-image` (builds the container image and runs the
     in-container R test against it — see `docs/development.md`).
6. Squash-merge after review.

## Local checks

```sh
# /edge and /frontend
npm run lint && npm run typecheck && npm run test && npm run build

# /worker (from a venv with requirements-dev.txt installed: pip install -r requirements-dev.txt)
ruff check . && ruff format --check . && pytest
```

See [`docs/development.md`](./docs/development.md) for the full local setup, including
building and running the `/worker` container image and running the whole stack together.

## Repo layout

No monorepo tool (Turborepo/Nx/pnpm workspaces) — three directories with their own manifests,
kept deliberately simple so CI jobs stay trivially separable. See the root `README.md` for the
architecture and `PLAN.md` for the full design rationale.
