"use client";

import { useEffect, useState, useCallback } from "react";
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
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { profiles, type Profile, type ProfileCreate } from "@/lib/api";
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

function CrawlStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "crawling":
      return (
        <Badge variant="outline" className="text-amber-600 border-amber-300">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Crawling
        </Badge>
      );
    case "complete":
      return (
        <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-green-300">
          Complete
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="secondary">Pending</Badge>;
  }
}

export default function ProfilesPage() {
  const router = useRouter();
  const [profileList, setProfileList] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");

  const fetchProfiles = useCallback(async () => {
    try {
      const data = await profiles.list();
      setProfileList(data);
    } catch {
      toast.error("Failed to load profiles");
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
    } catch {
      toast.error("Failed to create profile");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await profiles.delete(id);
      toast.success("Profile deleted");
      fetchProfiles();
    } catch {
      toast.error("Failed to delete profile");
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
            {profileList.length} total profiles
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={fetchProfiles}>
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
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center">
                  <Globe className="h-8 w-8 mx-auto text-muted-foreground/50" />
                  <p className="text-muted-foreground mt-2">
                    {search ? "No profiles match your search" : "No profiles yet"}
                  </p>
                  {!search && (
                    <Button
                      variant="link"
                      className="mt-2"
                      onClick={() => setDialogOpen(true)}
                    >
                      Create your first profile
                    </Button>
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
                      {profile.website_url}
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
                          onClick={() => handleDelete(profile.id)}
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
    </div>
  );
}
