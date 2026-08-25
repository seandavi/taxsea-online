import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("fetch handler", () => {
  it("wires up the real default export and returns a response for an unmatched path", async () => {
    // Not asserting a specific status here: an unmatched path falls through to the real
    // ASSETS binding, and what that returns (200 with the SPA shell via
    // `not_found_handling = "single-page-application"`, or 404 if ../frontend/dist is an
    // empty placeholder, as in ci-js.yml's edge job) depends on ambient build state this
    // test doesn't control. router.test.ts's "unmatched routes" suite covers the routing
    // contract itself with a fake ASSETS binding; this test only proves the exported
    // `fetch` handler is wired up and doesn't throw.
    const response = await exports.default.fetch("https://example.com/unknown");
    expect(response).toBeInstanceOf(Response);
  });
});
