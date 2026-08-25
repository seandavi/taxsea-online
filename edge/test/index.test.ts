import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("fetch handler", () => {
  it("returns 404 for unknown paths", async () => {
    const response = await exports.default.fetch("https://example.com/unknown");
    expect(response.status).toBe(404);
  });
});
