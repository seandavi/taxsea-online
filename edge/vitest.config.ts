import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs tests inside workerd via the Cloudflare Workers Vitest integration, so
// JobCoordinatorDO and the R2/rate-limiter bindings declared in wrangler.toml are
// real, not mocked.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
