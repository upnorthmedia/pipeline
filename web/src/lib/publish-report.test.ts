import { describe, it, expect } from "vitest";

import { lastPublishError } from "./publish-report";

/** The shape `appendExecutionLog` stores, with the keys it always writes. */
function entry(event: string, message: string): Record<string, unknown> {
  return { ts: "2026-08-24T00:00:00Z", stage: "", level: "error", event, message };
}

describe("lastPublishError", () => {
  it("returns null when the post has never published", () => {
    expect(lastPublishError([])).toBeNull();
  });

  it("ignores entries from the pipeline stages", () => {
    expect(
      lastPublishError([entry("stage_error", "research failed: Perplexity timed out")])
    ).toBeNull();
  });

  it("strips the WordPress hook's own prefix off its message", () => {
    expect(
      lastPublishError([
        entry("publish_error", "WordPress publish failed: WordPress credentials not configured"),
      ])
    ).toBe("WordPress credentials not configured");
  });

  it("strips the Next.js hook's prefix too", () => {
    expect(
      lastPublishError([entry("publish_error", "Next.js publish failed: Webhook returned 401: nope")])
    ).toBe("Webhook returned 401: nope");
  });

  it("keeps a message that carries neither prefix", () => {
    expect(lastPublishError([entry("publish_error", "Something else went wrong")])).toBe(
      "Something else went wrong"
    );
  });

  it("reports the last attempt, not the first", () => {
    expect(
      lastPublishError([
        entry("publish_error", "WordPress publish failed: first reason"),
        entry("publish_complete", "Published to WordPress: https://example.test/p/1"),
        entry("publish_error", "WordPress publish failed: second reason"),
      ])
    ).toBe("second reason");
  });

  it("turns WordPress's browser-facing markup into a sentence", () => {
    expect(
      lastPublishError([
        entry(
          "publish_error",
          "WordPress publish failed: <strong>Error:</strong> The password you entered for the username &#8220;admin&#8221; is incorrect."
        ),
      ])
    ).toBe("Error: The password you entered for the username “admin” is incorrect.");
  });

  it("returns null for an entry whose message is missing or blank", () => {
    expect(lastPublishError([{ event: "publish_error" }])).toBeNull();
    expect(lastPublishError([entry("publish_error", "WordPress publish failed:   ")])).toBeNull();
  });

  it("survives a logs column that is not an array of objects", () => {
    expect(lastPublishError(null)).toBeNull();
    expect(lastPublishError(["not an entry", 3])).toBeNull();
  });
});
