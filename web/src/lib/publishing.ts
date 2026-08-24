/**
 * What a post's `output_format` needs before it can name a destination.
 *
 * The three formats are not equals. `markdown` is the export and nothing
 * outside this app has to answer for it, so it is always available. The other
 * two are publish steps that run after the six pipeline stages have already
 * been paid for, and each one refuses on its own credentials before it does
 * anything else: `steps/wordpress-publish.ts` on `wp_url`, `wp_username` and
 * `wp_app_password`, `steps/nextjs-publish.ts` on `nextjs_webhook_url` and
 * `nextjs_webhook_secret`. Both also refuse a post with no profile at all,
 * because that is where the credentials live.
 *
 * So the question this module answers is the step's own precondition, read off
 * the profile the post is about to be attached to. It is a question about
 * stored configuration, not about reachability: a site that is configured and
 * currently down is a failure the connection card reports, not a format the
 * form should take away.
 */
import type { Profile } from "@/lib/api";

export interface OutputFormatOption {
  value: string;
  label: string;
}

export const OUTPUT_FORMATS: OutputFormatOption[] = [
  { value: "markdown", label: "Markdown" },
  { value: "wordpress", label: "WordPress (Direct Publish)" },
  { value: "nextjs", label: "Next.js (Webhook)" },
];

/**
 * The wire values, in the picker's order. The three of them are the whole
 * vocabulary of the `output_format` column: `src/app/api/output-format.ts`
 * refuses anything else at the write boundaries, and every reader treats a
 * value outside this list as configuration the user still has to fix.
 */
export const OUTPUT_FORMAT_VALUES: readonly string[] = OUTPUT_FORMATS.map((f) => f.value);

export function outputFormatLabel(value: string): string {
  return OUTPUT_FORMATS.find((f) => f.value === value)?.label ?? value;
}

/**
 * The two formats that name a destination outside this app, and so the two a
 * publish step can run against. `markdown` is an export, and a value outside
 * the vocabulary altogether (the retired `both`, on a row written before
 * `drizzle/0003`) names nothing, so neither is a target.
 */
export type PublishTarget = "wordpress" | "nextjs";

/**
 * The destination's name on its own, for a sentence that already says what is
 * being done to it. `outputFormatLabel` answers a different question, which is
 * which format to pick in a form, and its labels say how each one works.
 */
export const PUBLISH_TARGET_LABELS: Record<PublishTarget, string> = {
  wordpress: "WordPress",
  nextjs: "Next.js",
};

/** The destination an `output_format` names, or null when it names none. */
export function publishTargetOf(outputFormat: string | null | undefined): PublishTarget | null {
  return outputFormat === "wordpress" || outputFormat === "nextjs" ? outputFormat : null;
}

/** Why a format cannot be picked, in the words of whatever screen is asking. */
export type FormatAvailability = { available: true } | { available: false; reason: string };

/** Keyed by `OutputFormatOption.value`; a format with no entry is available. */
export type FormatAvailabilityMap = Record<string, FormatAvailability>;

/**
 * The credentials the two publish steps look for. Taken as a subset of
 * `Profile` rather than the whole thing so the profile editor can pass its
 * own unsaved form values, which is what makes the format open up as the
 * credentials are typed instead of only after a save.
 */
export type PublishCredentials = Pick<
  Profile,
  "wp_url" | "wp_username" | "wp_app_password_set" | "nextjs_webhook_url" | "nextjs_webhook_secret_set"
>;

export interface PublishTargets {
  wordpress: boolean;
  nextjs: boolean;
}

/** `null` is "no profile chosen", which neither publish step can survive. */
export function publishTargets(credentials: PublishCredentials | null): PublishTargets {
  if (!credentials) return { wordpress: false, nextjs: false };
  return {
    // An empty string is as missing as a null, exactly as the steps read it.
    wordpress: Boolean(
      credentials.wp_url && credentials.wp_username && credentials.wp_app_password_set
    ),
    nextjs: Boolean(credentials.nextjs_webhook_url && credentials.nextjs_webhook_secret_set),
  };
}
