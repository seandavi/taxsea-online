// `class_name = "JobCoordinatorDO"` in wrangler.toml's `[[containers]]` and
// `[[durable_objects.bindings]]` resolves against this main module's exports (`main =
// "src/index.ts"`), so the class has to stay re-exported here even though it now lives in
// its own file (issue #9).
export { JobCoordinatorDO } from "./JobCoordinatorDO";

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    // ponytail: no routes exist yet (issue #11 adds the public API router). Every
    // path 404s until then.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
