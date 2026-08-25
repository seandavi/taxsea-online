# edge

Cloudflare Worker: API router, `JobCoordinatorDO` (Durable Object + bound Container), R2
storage, WebSocket progress channel, and the static-asset host for the built frontend.

`wrangler.toml` here declares and deploys the `/worker` container image as part of
`wrangler deploy` — this is the only deploy pipeline for the whole project.
