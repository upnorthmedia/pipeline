"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, PauseCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STAGES, type PipelineStage, type Profile, type StageSettings } from "@/lib/api";
import {
  STAGE_LABELS,
  STAGE_MODE_LABELS,
  effectiveStageMode,
  stageModeOptions,
  stageModeStopsRun,
} from "@/lib/stages";

/** "This run" reads as a sentence subject in the title, mid-sentence below it. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "Outline", "Outline and Ready", "Outline, Images and Ready". */
function joinStageNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the run this form is about to start will do at each of the six stages.
 *
 * Editable when the caller passes `onChange`, which is the new-post form.
 * It was read-only everywhere until ledger item P2.114: `applyProfilePrefill`
 * copied the profile's gates over any submitted `stage_settings` equal to the
 * schema default, and six `auto`s is that default, so "no gates on this one
 * run" was a body the server discarded. A submitted value now wins, and the
 * card is where a gate is set for one post.
 *
 * `value` is the override and null means "whatever the profile says", which is
 * the difference between sending `stage_settings` and leaving it out. Every
 * edit writes all six stages rather than the one that changed: a
 * `stage_settings` with a hole in it parks the run at the stages it omits
 * (`DEFAULT_GATE_MODE` in `src/mastra/steps/stage-io.ts` falls back to
 * `review`), which no reader of this card would expect.
 *
 * `subject` names what the gates apply to, because `/posts/batch` copies the
 * same profile value onto up to twenty posts at once and "this run" would be a
 * lie there, and `/posts/[id]` edits the gates of a post that already exists.
 *
 * `onUseProfileGates` is the way back to the profile's own gates, and the
 * caller supplies it because only the caller knows whether there is one: the
 * new-post form drops its override and inherits again, while a created post
 * has no null to fall back to (`stage_settings: null` on a row means "run
 * every stage unattended", not "ask the profile").
 */
export const PipelineGatesCard = ({
  profile,
  title = "Pipeline",
  subject = "This run",
  value = null,
  onChange,
  onUseProfileGates,
}: {
  profile: Profile | null;
  title?: string;
  subject?: string;
  value?: StageSettings | null;
  onChange?: (next: StageSettings | null) => void;
  onUseProfileGates?: () => void;
}) => {
  const settings = value ?? profile?.default_stage_settings;
  const modes = STAGES.map((stage) => ({
    stage,
    mode: effectiveStageMode(stage, settings),
  }));
  const stopping = modes.filter((entry) => stageModeStopsRun(entry.mode));

  const setStage = (stage: PipelineStage, mode: string) => {
    const next = Object.fromEntries(
      modes.map((entry) => [entry.stage, entry.stage === stage ? mode : entry.mode])
    ) as StageSettings;
    onChange?.(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          Where {lowerFirst(subject)} will pause and wait for you
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {modes.map(({ stage, mode }) => (
            <li
              key={stage}
              data-testid={`gate-${stage}`}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <span className="text-sm font-medium">{STAGE_LABELS[stage]}</span>
              {onChange ? (
                <Select value={mode} onValueChange={(next) => setStage(stage, next)}>
                  <SelectTrigger
                    aria-label={STAGE_LABELS[stage]}
                    size="sm"
                    className="w-[190px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stageModeOptions(mode).map((option) => (
                      <SelectItem key={option} value={option}>
                        {STAGE_MODE_LABELS[option] ?? option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span
                  className={
                    stageModeStopsRun(mode)
                      ? "flex items-center gap-1.5 text-sm text-foreground"
                      : "flex items-center gap-1.5 text-sm text-muted-foreground"
                  }
                >
                  {stageModeStopsRun(mode) ? (
                    <PauseCircle className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <CircleCheck className="h-3.5 w-3.5 shrink-0" />
                  )}
                  {STAGE_MODE_LABELS[mode]}
                </span>
              )}
            </li>
          ))}
        </ul>

        <p data-testid="gate-summary" className="text-sm text-muted-foreground">
          {stopping.length > 0
            ? `${subject} will stop at ${joinStageNames(
                stopping.map(({ stage }) => STAGE_LABELS[stage])
              )} and wait for you.`
            : `${subject} will go from ${STAGE_LABELS[STAGES[0]]} to ${
                STAGE_LABELS[STAGES[STAGES.length - 1]]
              } without stopping.`}
        </p>

        {onUseProfileGates && (
          <div
            data-testid="gate-override"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
          >
            <span className="text-sm text-muted-foreground">
              Set for this post only.
              {profile ? ` The ${profile.name} profile is unchanged.` : ""}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onUseProfileGates}
            >
              Use the profile&apos;s gates
            </Button>
          </div>
        )}

        {profile && (
          <Link
            /* Straight to the tab that owns the gates: the profile editor has
               four of them and this one is three cards down the third. */
            href={`/profiles/${profile.id}?tab=defaults`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            {onChange
              ? `Change the default for new posts in ${profile.name}`
              : `Edit gates in the ${profile.name} profile`}
            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
};
