"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, PauseCircle } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { STAGES, type Profile } from "@/lib/api";
import {
  STAGE_LABELS,
  STAGE_MODE_LABELS,
  effectiveStageMode,
  stageModeStopsRun,
} from "@/lib/stages";

/** "Outline", "Outline and Ready", "Outline, Images and Ready". */
function joinStageNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the run this form is about to start will do at each of the six stages.
 *
 * Read-only on purpose. `stage_settings` is owned by the profile: it is copied
 * onto the post by `applyProfilePrefill`, and that copy fires whenever the
 * submitted value equals the schema default, so a per-post editor that cleared
 * every gate would send six `auto`s and have the profile's gates written back
 * over them without a word. Until that rule changes, the honest surface is one
 * that says what the run will do and points at the profile where it is
 * decided, rather than one that offers an edit the server discards.
 */
export const PipelineGatesCard = ({ profile }: { profile: Profile | null }) => {
  const settings = profile?.default_stage_settings;
  const modes = STAGES.map((stage) => ({
    stage,
    mode: effectiveStageMode(stage, settings),
  }));
  const stopping = modes.filter((entry) => stageModeStopsRun(entry.mode));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pipeline</CardTitle>
        <CardDescription>
          Where this run will pause and wait for you
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
            </li>
          ))}
        </ul>

        <p data-testid="gate-summary" className="text-sm text-muted-foreground">
          {stopping.length > 0
            ? `This run will stop at ${joinStageNames(
                stopping.map(({ stage }) => STAGE_LABELS[stage])
              )} and wait for you.`
            : `This run will go from ${STAGE_LABELS[STAGES[0]]} to ${
                STAGE_LABELS[STAGES[STAGES.length - 1]]
              } without stopping.`}
        </p>

        {profile && (
          <Link
            href={`/profiles/${profile.id}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            Edit gates in the {profile.name} profile
            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
};
