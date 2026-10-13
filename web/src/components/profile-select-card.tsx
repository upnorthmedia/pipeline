"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * A profile is required on both pages (ledger item P2.97): a post reaches its
 * owner only through `website_profiles.user_id`, so one written without a
 * profile is invisible to every read handler and `POST /api/posts` refuses it.
 * The picker therefore offers no "none" option, and both pages keep their
 * submit disabled until it has a value.
 *
 * The failure states say what to do rather than blocking silently: a load error
 * offers a retry, and an account with no profiles offers to create one, which
 * is the only way forward from there.
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

  // One profile is the common account, and a picker with a single option is a
  // required field nobody would think to open. The ref, not the `selected`
  // prop, is what keeps this to one call: `onSelect` is redefined on every
  // render of the page, so the effect re-runs before the page's own state
  // update has come back down as a new `selected`, and the page reads a second
  // selection as a second user choice, which on `/posts/new` refetches the
  // profile's WordPress categories and authors.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || selected || list.length !== 1) return;
    autoSelected.current = true;
    onSelect(list[0]);
  }, [list, selected, onSelect]);

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
              Every post belongs to a profile, which carries the niche, tone and
              publishing defaults so you do not retype them for every post.
            </p>
            <Link href="/profiles">
              <Button variant="outline" size="sm">
                Create a profile
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            <Select
              name="profile_id"
              value={selected?.id ?? ""}
              // Only ever upwards: with no "none" item there is nothing to
              // deselect to, and Radix answers the empty value this renders
              // before a pick with an `onValueChange("")` of its own, which
              // read as the page clearing its own selection.
              onValueChange={(v) => {
                const picked = list.find((p) => p.id === v);
                if (picked) onSelect(picked);
              }}
            >
              <SelectTrigger aria-label="Website profile">
                <SelectValue placeholder="Select a profile" />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!selected && (
              <p className="text-sm text-muted-foreground">
                Required: a post is filed under its profile, and its publishing
                settings come from there.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
