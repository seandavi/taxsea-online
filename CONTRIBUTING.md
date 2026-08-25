# Contributing

## Workflow

One issue, one branch, one PR:

1. Pick an open issue (see the milestone/issue breakdown in `PLAN.md` §6).
2. Branch off `main`: `git checkout -b issue-<number>-<short-description>`.
3. Implement only what that issue asks for — no drive-by scope creep into other issues.
4. Open a PR that references the issue (`Closes #<number>`).
5. CI must pass: `lint`, `typecheck`, and `test` for `/edge` and `/frontend`; `ruff check .`
   and `pytest` for `/worker`.
6. Squash-merge after review.

## Local checks

```sh
# /edge and /frontend
npm run lint && npm run typecheck && npm run test && npm run build

# /worker
ruff check . && ruff format --check . && pytest
```

## Repo layout

No monorepo tool (Turborepo/Nx/pnpm workspaces) — three directories with their own manifests,
kept deliberately simple so CI jobs stay trivially separable. See the root `README.md` for the
architecture and `PLAN.md` for the full design rationale.
