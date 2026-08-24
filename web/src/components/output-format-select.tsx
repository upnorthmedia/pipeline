"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OUTPUT_FORMATS,
  outputFormatLabel,
  type FormatAvailabilityMap,
} from "@/lib/publishing";

/**
 * The Output Format picker, shared by the new-post form and the profile
 * editor because both of them choose where a finished post goes and both of
 * them can be looking at a destination that is not configured.
 *
 * A greyed row inside a closed dropdown explains nothing, so every
 * unavailable format states its reason under the field whether or not the
 * list is open. The reason for the format that is currently selected is an
 * alert: the value is not rewritten behind the user's back, so the only thing
 * standing between them and a run that fails after six stages is that
 * sentence.
 */
export function OutputFormatSelect({
  value,
  onValueChange,
  availability,
  id = "outputFormat",
}: {
  value: string;
  onValueChange: (value: string) => void;
  availability: FormatAvailabilityMap;
  id?: string;
}) {
  const unavailable = OUTPUT_FORMATS.filter(
    (f) => availability[f.value]?.available === false
  );

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Output Format</Label>
      <Select name="output_format" value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OUTPUT_FORMATS.map((f) => (
            <SelectItem
              key={f.value}
              value={f.value}
              disabled={availability[f.value]?.available === false}
            >
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {unavailable.map((f) => {
        const entry = availability[f.value];
        if (!entry || entry.available) return null;
        const selected = f.value === value;
        return (
          <p
            key={f.value}
            role={selected ? "alert" : undefined}
            className={
              selected ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {outputFormatLabel(f.value)}: {entry.reason}
          </p>
        );
      })}
    </div>
  );
}
