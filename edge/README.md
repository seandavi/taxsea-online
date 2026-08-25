# edge

Cloudflare Worker: API router, `JobCoordinatorDO` (Durable Object + bound Container), R2
storage, WebSocket progress channel, and the static-asset host for the built frontend.

`wrangler.toml` here declares and deploys the `/worker` container image as part of
`wrangler deploy` — this is the only deploy pipeline for the whole project.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in a real WORKER_SHARED_SECRET; .dev.vars is gitignored
npm run dev                      # wrangler dev
```

`wrangler dev` builds and runs the `/worker` container image locally as part of starting
up, so it requires a working local Docker daemon (`docker ps` should succeed). `.dev.vars`
supplies `WORKER_SHARED_SECRET` for local dev the same way `wrangler secret put` does for a
deployed environment — never commit `.dev.vars` itself.

See [`../docs/development.md`](../docs/development.md) for the full three-component setup,
the "run the whole stack" sequence, and troubleshooting (container image build looking like
a hang, jobs stuck in `running`, 401s, etc).

## Other scripts

```sh
npm run lint        # eslint (extends the shared root config with TypeScript rules)
npm run typecheck   # tsc --noEmit against src/ and test/ (separate tsconfigs)
npm run test        # vitest, running in workerd via @cloudflare/vitest-plugin
npm run build       # wrangler deploy --dry-run, the same bundling step CI/deploy use
npm run types       # regenerate worker-configuration.d.ts after changing wrangler.toml
```

`npm run build` needs `../frontend/dist` (the built SPA, M4) and a real `/worker/Dockerfile`
image (M2) to fully succeed; both are cross-milestone dependencies of this scaffolding
issue, not bugs in `/edge` itself.
