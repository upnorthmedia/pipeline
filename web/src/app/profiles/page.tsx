"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Globe,
  RefreshCw,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  Loader2,
  Search,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { CrawlStatusBadge } from "@/components/crawl-status-badge";
import {
  profiles,
  apiErrorMessage,
  type ProfileListItem,
  type ProfileCreate,
} from "@/lib/api";
import {
  URL_CREDENTIALS_WARNING,
  hasUrlCredentials,
  stripUrlCredentials,
} from "@/lib/url-credentials";
import { toast } from "sonner";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "1 post" against "3 posts", so the sentence around it reads either way. */
function countPosts(count: number): string {
  return count === 1 ? "1 post" : `${count} posts`;
}

export default function ProfilesPage() {
  const router = useRouter();
  const [profileList, setProfileList] = useState<ProfileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  // The whole row, not the id: the confirmation names the profile and counts
  // what the press would take with it, and both come off the row the reader
  // was looking at when they opened the menu.
  const [deleteTarget, setDeleteTarget] = useState<ProfileListItem | null>(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await profiles.list();
      setProfileList(data);
      setError(null);
    } catch (e) {
      // A route handler that dies before it can answer sends an empty 500
      // body, so there is often nothing of the server's own to show.
      setError(
        apiErrorMessage(e, "The request failed and the server gave no reason.")
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const filtered = search
    ? profileList.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.website_url.toLowerCase().includes(search.toLowerCase())
      )
    : profileList;

  const handleCreate = async () => {
    if (!formName.trim() || !formUrl.trim()) {
      toast.error("Name and website URL are required");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const data: ProfileCreate = {
        name: formName.trim(),
        website_url: formUrl.trim(),
      };
      const created = await profiles.create(data);
      toast.success("Profile created");
      setDialogOpen(false);
      setFormName("");
      setFormUrl("");
      router.push(`/profiles/${created.id}`);
    } catch (e) {
      // The dialog stays open with the fields still filled in: a four-second
      // toast is the wrong place for the reason a submit was rejected.
      setCreateError(apiErrorMessage(e, "The profile could not be created."));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (target: ProfileListItem) => {
    const withPosts = target.post_count > 0;
    try {
      await profiles.delete(target.id, { withPosts });
      toast.success(
        withPosts
          ? `Profile and ${countPosts(target.post_count)} deleted`
          : "Profile deleted"
      );
      setDeleteTarget(null);
      fetchProfiles();
    } catch (e) {
      // A profile with posts still on it is refused, and the refusal names
      // how many and what to do about it. Replacing that with "Failed to
      // delete profile" left a click that looked like it did nothing.
      toast.error(apiErrorMessage(e, "The profile could not be deleted."));
    }
  };

  const handleCrawl = async (id: string) => {
    try {
      await profiles.crawl(id);
      toast.success("Sitemap crawl started");
      fetchProfiles();
    } catch {
      toast.error("Failed to start crawl");
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Website Profiles
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {loading
              ? "Loading profiles..."
              : error
                ? "Profile list unavailable"
                : `${profileList.length} total profile${profileList.length === 1 ? "" : "s"}`}
          </p>
          {/* The whole boundary in one sentence, on the page a user reaches
              first when they go looking for a setting. */}
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A profile owns one site: its voice, publishing connection, internal
            links and the defaults new posts start from. API keys, stage models
            and rule files are account-wide:{" "}
            <Link
              href="/settings"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Account
            </Link>
            .
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh profiles"
            onClick={fetchProfiles}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Profile
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Profile</DialogTitle>
                <DialogDescription>
                  Name the site and give its URL. Everything else is editable
                  once the profile exists.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="profile-name">Name</Label>
                  <Input
                    id="profile-name"
                    placeholder="My Website"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="profile-url">Website URL</Label>
                  <Input
                    id="profile-url"
                    placeholder="https://example.com"
                    value={formUrl}
                    onChange={(e) => setFormUrl(e.target.value)}
                  />
                </div>
                {createError && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        Could not create the profile
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {createError}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            name="profile-search"
            aria-label="Search profiles"
            placeholder="Search profiles..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Website URL</TableHead>
              <TableHead className="w-[80px]">Posts</TableHead>
              <TableHead className="w-[120px]">Crawl Status</TableHead>
              <TableHead className="w-[120px]">Last Crawled</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-48" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-6" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-4" />
                  </TableCell>
                </TableRow>
              ))
            ) : error ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-40 text-center">
                  <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
                  <p className="mt-2 text-sm font-medium">
                    Could not load profiles
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={fetchProfiles}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    Retry
                  </Button>
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-40 text-center">
                  <Globe className="h-8 w-8 mx-auto text-muted-foreground/50" />
                  {search ? (
                    <>
                      <p className="mt-2 text-sm font-medium">
                        No profiles match your search
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Search matches the profile name and its website URL.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => setSearch("")}
                      >
                        Clear search
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-sm font-medium">No profiles yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        A profile holds the site, voice and links every post is
                        written against.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => setDialogOpen(true)}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1.5" />
                        Create your first profile
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((profile) => (
                <TableRow
                  key={profile.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/profiles/${profile.id}`)}
                >
                  <TableCell>
                    <p className="font-medium text-sm">{profile.name}</p>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {stripUrlCredentials(profile.website_url)}
                    </span>
                    {hasUrlCredentials(profile.website_url) && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 rounded border border-amber-500/40 px-1.5 py-0.5 align-middle text-[11px] text-amber-600 dark:text-amber-400"
                        title={URL_CREDENTIALS_WARNING}
                      >
                        <AlertCircle className="h-3 w-3" aria-hidden="true" />
                        Password in URL
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        profile.post_count === 0
                          ? "text-sm text-muted-foreground"
                          : "text-sm tabular-nums"
                      }
                    >
                      {profile.post_count === 0 ? "None" : profile.post_count}
                    </span>
                  </TableCell>
                  <TableCell>
                    <CrawlStatusBadge status={profile.crawl_status} />
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {profile.last_crawled_at
                        ? timeAgo(profile.last_crawled_at)
                        : "Never"}
                    </span>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Row actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            router.push(`/profiles/${profile.id}`)
                          }
                        >
                          <ExternalLink className="h-3.5 w-3.5 mr-2" />
                          View Detail
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleCrawl(profile.id)}
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-2" />
                          Crawl Sitemap
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setDeleteTarget(profile)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete confirmation. The count decides both the question and the
          button, because the handler behind them is two different actions:
          with posts attached it takes them too, and that is not something to
          discover afterwards. */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget && deleteTarget.post_count > 0
                ? `Delete "${deleteTarget.name}" and its ${countPosts(deleteTarget.post_count)}?`
                : `Delete "${deleteTarget?.name ?? ""}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.post_count > 0
                ? `Deleting this profile deletes its ${countPosts(deleteTarget.post_count)} too, with their drafts and generated images. This cannot be undone.`
                : "This profile has no posts. Its internal links and publishing settings go with it. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/*
              `variant`, not a `className` override: `AlertDialogAction` puts
              the child's class inside its own `Button` through a `Slot`, which
              concatenates the two lists instead of merging them.
            */}
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                // The dialog is dismissed by `handleDelete` on success, so a
                // refusal keeps the question on screen beside its reason.
                e.preventDefault();
                if (deleteTarget) handleDelete(deleteTarget);
              }}
            >
              {deleteTarget && deleteTarget.post_count > 0
                ? `Delete profile and ${countPosts(deleteTarget.post_count)}`
                : "Delete profile"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
