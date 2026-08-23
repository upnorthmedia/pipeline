"use client";

/**
 * The per-stage model and effort table ledger item 6.3 asks for.
 *
 * Its own file rather than another block inside `page.tsx` because it owns a
 * per-row draft, a per-row save and a per-row error, and folding that into the
 * page's flat key/rule state would leave one component tracking three
 * unrelated forms.
 *
 * Two decisions worth stating.
 *
 * **The effective value is what a selector shows, not the override.** A stage
 * a user has never touched still runs on something: the operator's global row,
 * or the verified default underneath it. Showing that value with a badge for
 * where it came from means the table always reads as the configuration the
 * pipeline will run, and never as an empty form.
 *
 * **Reverting clears the stage, it does not write the default back.** Storing
 * the resolved value as an override would freeze today's fallback into the
 * user's row, so a later change to the global row would stop reaching them.
 * The revert button drops the stage's entry from the map instead.
 */

import { useCallback, useEffect, useState } from "react";
import { Cpu, Loader2, RotateCcw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  apiErrorMessage,
  stageModels,
  type PipelineStage,
  type StageModelRow,
  type StageModels,
} from "@/lib/api";
import { toast } from "sonner";

/** A row's edited-but-unsaved model and effort, keyed by stage. */
type Draft = Partial<Record<PipelineStage, { model: string; effort: string | null }>>;

const SOURCE_LABEL = {
  default: "Default",
  global: "Global",
  user: "Override",
} as const;

function SourceBadge({ row }: { row: StageModelRow }) {
  // One badge per row: an override on either field makes the row an override,
  // because that is what the revert button clears.
  const source =
    row.model_source === "user" || row.effort_source === "user"
      ? "user"
      : row.model_source === "global" || row.effort_source === "global"
        ? "global"
        : "default";

  return (
    <Badge
      variant="outline"
      className={
        source === "user"
          ? "border-primary/40 text-primary"
          : "text-muted-foreground"
      }
    >
      {SOURCE_LABEL[source]}
    </Badge>
  );
}

export function StageModelsCard() {
  const [data, setData] = useState<StageModels | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState<PipelineStage | null>(null);
  const [rowErrors, setRowErrors] = useState<Partial<Record<PipelineStage, string>>>({});

  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    stageModels
      .get()
      .then((next) => {
        setData(next);
        setDraft({});
      })
      .catch((error) =>
        setLoadError(apiErrorMessage(error, "Failed to load stage models"))
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const effective = (row: StageModelRow) =>
    draft[row.stage] ?? { model: row.model, effort: row.effort };

  const isDirty = (row: StageModelRow) => {
    const current = effective(row);
    return current.model !== row.model || current.effort !== row.effort;
  };

  const edit = (row: StageModelRow, patch: { model?: string; effort?: string }) =>
    setDraft((prev) => ({
      ...prev,
      [row.stage]: { ...effective(row), ...patch },
    }));

  /**
   * Writes the whole overrides map with one stage replaced or removed. The
   * setting is a single row value, so a partial write would drop every other
   * stage's override.
   */
  const write = async (row: StageModelRow, entry: { model: string; effort: string | null } | null) => {
    if (!data) return;
    setSaving(row.stage);
    setRowErrors((prev) => ({ ...prev, [row.stage]: "" }));

    const overrides = { ...data.overrides };
    if (entry === null) {
      delete overrides[row.stage];
    } else {
      overrides[row.stage] = entry.effort === null
        ? { model: entry.model }
        : { model: entry.model, effort: entry.effort };
    }

    try {
      const next = await stageModels.update(overrides);
      setData(next);
      setDraft((prev) => {
        const rest = { ...prev };
        delete rest[row.stage];
        return rest;
      });
      toast.success(
        entry === null
          ? `${row.stage} reverted to default`
          : `${row.stage} model saved`
      );
    } catch (error) {
      // The server names the offending stage and the accepted values, so its
      // wording is more useful than anything this component could invent.
      const message = apiErrorMessage(error, `Failed to save ${row.stage}`);
      setRowErrors((prev) => ({ ...prev, [row.stage]: message }));
      toast.error(message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu className="h-4 w-4" />
          Stage Models
        </CardTitle>
        <CardDescription>
          Model and reasoning effort per pipeline stage. Only verified model ids
          are selectable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-3" data-testid="stage-models-loading">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 flex-1" />
                <Skeleton className="h-9 w-28" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {data?.stages.map((row) => {
              const current = effective(row);
              const busy = saving === row.stage;
              return (
                <div key={row.stage} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium capitalize">
                        {row.stage}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.provider}
                      </span>
                    </div>
                    <SourceBadge row={row} />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={current.model}
                      onValueChange={(model) => edit(row, { model })}
                    >
                      <SelectTrigger
                        className="w-[230px]"
                        aria-label={`${row.stage} model`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {row.models.map((id) => (
                          <SelectItem key={id} value={id}>
                            {id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {row.efforts.length > 0 ? (
                      <Select
                        value={current.effort ?? undefined}
                        onValueChange={(effort) => edit(row, { effort })}
                      >
                        <SelectTrigger
                          className="w-[110px]"
                          aria-label={`${row.stage} effort`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {row.efforts.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="w-[110px] text-xs text-muted-foreground">
                        no effort setting
                      </span>
                    )}

                    <div className="ml-auto flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy || !isDirty(row)}
                        onClick={() => write(row, current)}
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1.5">Save</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          (row.model_source !== "user" && row.effort_source !== "user")
                        }
                        onClick={() => write(row, null)}
                        aria-label={`Revert ${row.stage} to default`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span className="ml-1.5">Revert</span>
                      </Button>
                    </div>
                  </div>

                  {rowErrors[row.stage] && (
                    <p className="text-xs text-destructive">{rowErrors[row.stage]}</p>
                  )}
                  {(row.model_source === "user" || row.effort_source === "user") && (
                    <p className="text-xs text-muted-foreground">
                      Reverts to {row.fallback_model}
                      {row.fallback_effort ? ` / ${row.fallback_effort}` : ""}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
