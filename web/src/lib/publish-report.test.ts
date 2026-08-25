import { describe, it, expect } from "vitest";

import {
  lastPublishError,
  lastPublishStartAt,
  PUBLISH_STALL_AFTER_MS,
  publishStall,
} from "./publish-report";

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

/** The `publish_start` entry, which is the only one carrying a pickup time. */
function startEntry(ts: string): Record<string, unknown> {
  return { ts, stage: "", level: "info", event: "publish_start", message: "Publishing to WordPress..." };
}

describe("lastPublishStartAt", () => {
  it("returns null when no worker ever picked the post up", () => {
    expect(lastPublishStartAt([])).toBeNull();
    expect(lastPublishStartAt([entry("publish_error", "WordPress publish failed: nope")])).toBeNull();
  });

  it("returns the latest pickup, not the first", () => {
    expect(
      lastPublishStartAt([
        startEntry("2026-08-24T10:00:00Z"),
        entry("publish_error", "WordPress publish failed: nope"),
        startEntry("2026-08-24T12:00:00Z"),
      ])
    ).toBe("2026-08-24T12:00:00Z");
  });

  it("refuses a timestamp it cannot read rather than guessing at one", () => {
    expect(lastPublishStartAt([startEntry("not a date")])).toBeNull();
    expect(lastPublishStartAt(null)).toBeNull();
  });
});

describe("publishStall", () => {
  const REQUESTED = "2026-08-24T12:00:00Z";
  const NOW = Date.parse(REQUESTED) + PUBLISH_STALL_AFTER_MS;

  it("says nothing about a status that is not in flight", () => {
    for (const status of ["published", "failed", null, undefined, ""]) {
      expect(
        publishStall({ status, updatedAt: REQUESTED, executionLogs: [], now: NOW })
      ).toBeNull();
    }
  });

  it("leaves a publish inside the window alone", () => {
    expect(
      publishStall({
        status: "publishing",
        updatedAt: REQUESTED,
        executionLogs: [],
        now: NOW - 1,
      })
    ).toBeNull();
  });

  it("names the worker when one picked the post up and then went quiet", () => {
    const stall = publishStall({
      status: "publishing",
      updatedAt: REQUESTED,
      executionLogs: [startEntry(REQUESTED)],
      now: NOW,
    });
    expect(stall?.started).toBe(true);
    expect(stall?.reason).toMatch(/the worker died partway through/);
  });

  it("names the queue when nothing ever picked it up", () => {
    const stall = publishStall({
      status: "pending",
      updatedAt: REQUESTED,
      executionLogs: [],
      now: NOW,
    });
    expect(stall?.started).toBe(false);
    expect(stall?.reason).toMatch(/no worker has picked it up/);
  });

  /**
   * The clock is the later of the two, so a worker that took the post ten
   * minutes after it was queued gets its own full window rather than the
   * remainder of the queue's.
   */
  it("measures from the pickup when the pickup is the later of the two", () => {
    const pickedUp = Date.parse(REQUESTED) + 10 * 60_000;
    const logs = [startEntry(new Date(pickedUp).toISOString())];
    expect(
      publishStall({ status: "publishing", updatedAt: REQUESTED, executionLogs: logs, now: NOW })
    ).toBeNull();
    expect(
      publishStall({
        status: "publishing",
        updatedAt: REQUESTED,
        executionLogs: logs,
        now: pickedUp + PUBLISH_STALL_AFTER_MS,
      })?.started
    ).toBe(true);
  });

  /**
   * A `publish_start` from an attempt made before this one was requested says
   * nothing about this one, and it must not be read as a pickup: the retry
   * that produced the new request stamped `updated_at` past it.
   */
  it("ignores a pickup that belongs to an earlier attempt", () => {
    const stall = publishStall({
      status: "pending",
      updatedAt: REQUESTED,
      executionLogs: [startEntry("2026-08-20T09:00:00Z")],
      now: NOW,
    });
    expect(stall?.started).toBe(false);
  });

  it("calls nothing stalled when the row carries no clock at all", () => {
    expect(
      publishStall({ status: "publishing", updatedAt: null, executionLogs: [], now: NOW })
    ).toBeNull();
    expect(
      publishStall({ status: "publishing", updatedAt: "not a date", executionLogs: [], now: NOW })
    ).toBeNull();
  });
});
