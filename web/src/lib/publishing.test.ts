import { describe, expect, it } from "vitest";

import { makeProfile } from "@/test/fixtures";
import { publishTargets } from "./publishing";

/**
 * `publishTargets` answers the same question the two publish steps ask before
 * they do anything else, so these cases are the step preconditions read from
 * `src/mastra/steps/wordpress-publish.ts` and `src/mastra/steps/nextjs-publish.ts`.
 */
describe("publishTargets", () => {
  it("has no target at all without a profile", () => {
    expect(publishTargets(null)).toEqual({ wordpress: false, nextjs: false });
  });

  it("needs all three WordPress credentials, not just the two visible ones", () => {
    const withUrlAndUser = makeProfile({
      wp_url: "https://wp.example.com",
      wp_username: "editor",
    });
    expect(publishTargets(withUrlAndUser).wordpress).toBe(false);
    expect(
      publishTargets({ ...withUrlAndUser, wp_app_password_set: true }).wordpress
    ).toBe(true);
  });

  it("treats an empty string as missing, the way the step does", () => {
    expect(
      publishTargets(
        makeProfile({ wp_url: "", wp_username: "editor", wp_app_password_set: true })
      ).wordpress
    ).toBe(false);
  });

  it("needs both the webhook URL and the webhook secret", () => {
    const urlOnly = makeProfile({
      nextjs_webhook_url: "https://blog.example/api/jena-webhook",
    });
    expect(publishTargets(urlOnly).nextjs).toBe(false);
    expect(publishTargets({ ...urlOnly, nextjs_webhook_secret_set: true }).nextjs).toBe(
      true
    );
  });

  it("reads the two destinations independently", () => {
    const wpOnly = makeProfile({
      wp_url: "https://wp.example.com",
      wp_username: "editor",
      wp_app_password_set: true,
    });
    expect(publishTargets(wpOnly)).toEqual({ wordpress: true, nextjs: false });
  });
});
