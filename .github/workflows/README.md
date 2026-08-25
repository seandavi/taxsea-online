# .github

GitHub Actions workflows: `ci-js.yml` (edge + frontend lint/typecheck/test), `ci-worker.yml`
(worker lint/test + image build check), and `deploy.yml` (single `wrangler deploy` on push to
`main`). No workflow triggers on `pull_request` with secrets, so fork PRs never reach
credentials.
