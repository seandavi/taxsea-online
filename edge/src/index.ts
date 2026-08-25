import { Container } from "@cloudflare/containers";

/**
 * The job coordinator Durable Object. `Container` (from `@cloudflare/containers`)
 * extends `DurableObject`, so this one class is simultaneously the job coordinator
 * and the container-backed class bound in wrangler.toml's `[[containers]]` and
 * `[[durable_objects.bindings]]` blocks.
 *
 * ponytail: stub only -- container dispatch, the job state machine, and the timeout
 * alarm land in issue #9. This issue delivers configuration and a trivial fetch
 * handler only.
 */
export class JobCoordinatorDO extends Container {
  defaultPort = 8080;
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    // ponytail: no routes exist yet (issue #11 adds the public API router). Every
    // path 404s until then.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
