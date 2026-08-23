"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";
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
import { apiErrorMessage, profiles, type Profile } from "@/lib/api";

interface ProfileSelectCardProps {
  /** What picking a profile does on this page. */
  description: string;
  selected: Profile | null;
  onSelect: (profile: Profile | null) => void;
}

/**
 * The "Website Profile" picker shared by `/posts/new` and `/posts/batch`.
 *
 * A profile is optional on both pages, so none of the failure states block the
 * form: a load error and an account with no profiles both leave the page usable
 * with no profile selected, they just say so instead of showing a select whose
 * only option is "No profile".
 */
export function ProfileSelectCard({
  description,
  selected,
  onSelect,
}: ProfileSelectCardProps) {
  const [list, setList] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await profiles.list();
      setList(data);
      setError(null);
    } catch (e) {
      setError(
        apiErrorMessage(e, "The request failed and the server gave no reason.")
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Website Profile</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-full" data-testid="profile-select-loading" />
        ) : error ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium">Could not load profiles</p>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : list.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">No profiles yet</p>
            <p className="text-sm text-muted-foreground">
              A profile carries the niche, tone and publishing defaults so you do
              not retype them for every post.
            </p>
            <Link href="/profiles">
              <Button variant="outline" size="sm">
                Create a profile
              </Button>
            </Link>
          </div>
        ) : (
          <Select
            name="profile_id"
            value={selected?.id ?? "none"}
            onValueChange={(v) =>
              onSelect(v === "none" ? null : list.find((p) => p.id === v) ?? null)
            }
          >
            <SelectTrigger aria-label="Website profile">
              <SelectValue placeholder="No profile (manual config)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No profile</SelectItem>
              {list.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardContent>
    </Card>
  );
}
