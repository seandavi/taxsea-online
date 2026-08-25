# frontend

React SPA (Vite) — job submission form, WebSocket/polling progress view, and results table.
Builds to `dist/`, served as static assets by the `/edge` Worker (no separate hosting).

## Local development

```sh
npm install
npm run dev   # vite, http://localhost:5173
```

Requires `wrangler dev` (see `/edge`) already running on `:8787` — `vite.config.ts` proxies
`/api` there, with `ws: true` so the WebSocket upgrade for `/api/jobs/:jobId/ws` proxies
too, not just plain HTTP. See [`../docs/development.md`](../docs/development.md) for the
full three-component setup and troubleshooting.
