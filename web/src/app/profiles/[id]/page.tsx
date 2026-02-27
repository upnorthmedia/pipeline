"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Save,
  RefreshCw,
  Plus,
  Trash2,
  Search,
  Loader2,
  ExternalLink,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  profiles,
  type Profile,
  type InternalLink,
  type PaginatedLinks,
  type StageMode,
  type PipelineStage,
  STAGES,
} from "@/lib/api";
import { toast } from "sonner";

const OUTPUT_FORMATS = [
  { value: "both", label: "Both (MD + HTML)" },
  { value: "markdown", label: "Markdown only" },
  { value: "wordpress", label: "WordPress HTML only" },
];

const STAGE_MODES: { value: StageMode; label: string }[] = [
  { value: "review", label: "Review" },
  { value: "auto", label: "Auto" },
  { value: "approve_only", label: "Approve" },
];

const CRAWL_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  idle: "secondary",
  crawling: "default",
  complete: "outline",
  failed: "destructive",
};

export default function ProfileDetailPage() {
  const params = useParams();
  const router = useRouter();
  const profileId = params.id as string;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const crawlPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [niche, setNiche] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [tone, setTone] = useState("Conversational and friendly");
  const [brandVoice, setBrandVoice] = useState("");
  const [wordCount, setWordCount] = useState(2000);
  const [outputFormat, setOutputFormat] = useState("both");
  const [imageStyle, setImageStyle] = useState("");
  const [imageBrandColors, setImageBrandColors] = useState("");
  const [imageExclude, setImageExclude] = useState("");
  const [avoid, setAvoid] = useState("");
  const [requiredMentions, setRequiredMentions] = useState("");
  const [relatedKeywords, setRelatedKeywords] = useState("");
  const [recrawlInterval, setRecrawlInterval] = useState<string>("disabled");
  const [stageSettings, setStageSettings] = useState<Record<PipelineStage, StageMode>>({
    research: "review",
    outline: "review",
    write: "review",
    edit: "review",
    images: "review",
    ready: "review",
  });

  // Links state
  const [links, setLinks] = useState<InternalLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksPage, setLinksPage] = useState(1);
  const [linksHasMore, setLinksHasMore] = useState(false);
  const [linksSearch, setLinksSearch] = useState("");
  const [showAddLink, setShowAddLink] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [newLinkTitle, setNewLinkTitle] = useState("");
  const [addingLink, setAddingLink] = useState(false);

  const LINKS_PER_PAGE = 20;

  const populateForm = useCallback((p: Profile) => {
    setName(p.name);
    setWebsiteUrl(p.website_url);
    setNiche(p.niche || "");
    setTargetAudience(p.target_audience || "");
    setTone(p.tone || "Conversational and friendly");
    setBrandVoice(p.brand_voice || "");
    setWordCount(p.word_count || 2000);
    setOutputFormat(p.output_format || "both");
    setImageStyle(p.image_style || "");
    setImageBrandColors((p.image_brand_colors || []).join(", "));
    setImageExclude((p.image_exclude || []).join(", "));
    setAvoid(p.avoid || "");
    setRequiredMentions(p.required_mentions || "");
    setRelatedKeywords((p.related_keywords || []).join(", "));
    setRecrawlInterval(p.recrawl_interval || "disabled");
    setStageSettings(p.default_stage_settings);
  }, []);

  const fetchProfile = useCallback(async () => {
    try {
      const data = await profiles.get(profileId);
      setProfile(data);
      return data;
    } catch {
      toast.error("Failed to load profile");
      router.push("/profiles");
      return null;
    }
  }, [profileId, router]);

  const fetchLinks = useCallback(
    async (page: number, search: string, append = false) => {
      setLinksLoading(true);
      try {
        const data = await profiles.links(profileId, {
          page,
          per_page: LINKS_PER_PAGE,
          q: search || undefined,
        });
        if (append) {
          setLinks((prev) => [...prev, ...data.items]);
        } else {
          setLinks(data.items);
        }
        setLinksHasMore(page < data.pages);
      } catch {
        toast.error("Failed to load links");
      } finally {
        setLinksLoading(false);
      }
    },
    [profileId]
  );

  useEffect(() => {
    (async () => {
      const data = await fetchProfile();
      if (data) populateForm(data);
      setLoading(false);
    })();
  }, [fetchProfile, populateForm]);

  useEffect(() => {
    if (!loading) {
      setLinksPage(1);
      fetchLinks(1, linksSearch);
    }
  }, [loading, linksSearch, fetchLinks]);

  // Crawl polling
  useEffect(() => {
    if (profile?.crawl_status === "crawling") {
      crawlPollRef.current = setInterval(async () => {
        const updated = await fetchProfile();
        if (updated && updated.crawl_status !== "crawling") {
          if (crawlPollRef.current) clearInterval(crawlPollRef.current);
          crawlPollRef.current = null;
          if (updated.crawl_status === "complete") {
            toast.success("Sitemap crawl complete");
            fetchLinks(1, linksSearch);
            setLinksPage(1);
          } else {
            toast.error("Sitemap crawl failed");
          }
        }
      }, 3000);
    }
    return () => {
      if (crawlPollRef.current) {
        clearInterval(crawlPollRef.current);
        crawlPollRef.current = null;
      }
    };
  }, [profile?.crawl_status, fetchProfile, fetchLinks, linksSearch]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !websiteUrl.trim()) {
      toast.error("Name and Website URL are required");
      return;
    }

    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        website_url: websiteUrl.trim(),
        niche: niche || null,
        target_audience: targetAudience || null,
        tone,
        brand_voice: brandVoice || null,
        word_count: wordCount,
        output_format: outputFormat,
        image_style: imageStyle || null,
        image_brand_colors: imageBrandColors
          ? imageBrandColors.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        image_exclude: imageExclude
          ? imageExclude.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        avoid: avoid || null,
        required_mentions: requiredMentions || null,
        related_keywords: relatedKeywords
          ? relatedKeywords.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        default_stage_settings: stageSettings,
        recrawl_interval: recrawlInterval === "disabled" ? null : recrawlInterval,
      };
      const updated = await profiles.update(profileId, data);
      setProfile(updated);
      toast.success("Profile saved");
    } catch {
      toast.error("Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  const handleCrawl = async () => {
    try {
      await profiles.crawl(profileId);
      toast.success("Sitemap crawl started");
      const updated = await fetchProfile();
      if (updated) setProfile(updated);
    } catch {
      toast.error("Failed to start crawl");
    }
  };

  const handleAddLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLinkUrl.trim()) {
      toast.error("URL is required");
      return;
    }

    setAddingLink(true);
    try {
      await profiles.createLink(profileId, {
        url: newLinkUrl.trim(),
        title: newLinkTitle.trim() || undefined,
      });
      toast.success("Link added");
      setNewLinkUrl("");
      setNewLinkTitle("");
      setShowAddLink(false);
      setLinksPage(1);
      fetchLinks(1, linksSearch);
    } catch {
      toast.error("Failed to add link");
    } finally {
      setAddingLink(false);
    }
  };

  const handleDeleteLink = async (linkId: string) => {
    try {
      await profiles.deleteLink(profileId, linkId);
      toast.success("Link deleted");
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
    } catch {
      toast.error("Failed to delete link");
    }
  };

  const handleLoadMore = () => {
    const nextPage = linksPage + 1;
    setLinksPage(nextPage);
    fetchLinks(nextPage, linksSearch, true);
  };

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-3xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!profile) return null;

  const isCrawling = profile.crawl_status === "crawling";

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Link href="/profiles">
          <Button variant="ghost" size="icon" className="mt-1">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{profile.name}</h1>
          <div className="flex items-center gap-1.5 mt-0.5 text-sm text-muted-foreground">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <a
              href={profile.website_url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline truncate"
            >
              {profile.website_url}
            </a>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </div>
        </div>
      </div>

      {/* Profile Settings Form */}
      <form onSubmit={handleSave} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile Settings</CardTitle>
            <CardDescription>Core profile configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="websiteUrl">
                  Website URL <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="websiteUrl"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="https://example.com"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="niche">Niche</Label>
                <Input
                  id="niche"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder="e.g., Firearms & Accessories"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="targetAudience">Target Audience</Label>
                <Input
                  id="targetAudience"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  placeholder="e.g., Gun enthusiasts"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tone">Tone</Label>
                <Input
                  id="tone"
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wordCount">Word Count</Label>
                <Input
                  id="wordCount"
                  type="number"
                  min={500}
                  max={10000}
                  step={100}
                  value={wordCount}
                  onChange={(e) => setWordCount(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="brandVoice">Brand Voice</Label>
              <Textarea
                id="brandVoice"
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
                placeholder="Describe the brand's voice and personality..."
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Output Format</Label>
                <Select value={outputFormat} onValueChange={setOutputFormat}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OUTPUT_FORMATS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="avoid">Avoid</Label>
                <Input
                  id="avoid"
                  value={avoid}
                  onChange={(e) => setAvoid(e.target.value)}
                  placeholder="Words or phrases to avoid"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="requiredMentions">Required Mentions</Label>
              <Input
                id="requiredMentions"
                value={requiredMentions}
                onChange={(e) => setRequiredMentions(e.target.value)}
                placeholder="Brands, products, or phrases that must be mentioned"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="relatedKeywords">Related Keywords</Label>
              <Input
                id="relatedKeywords"
                value={relatedKeywords}
                onChange={(e) => setRelatedKeywords(e.target.value)}
                placeholder="keyword1, keyword2, keyword3"
              />
              <p className="text-[11px] text-muted-foreground">
                Comma-separated. Used as default keywords for new posts.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Image Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Image Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="imageStyle">Image Style</Label>
              <Input
                id="imageStyle"
                value={imageStyle}
                onChange={(e) => setImageStyle(e.target.value)}
                placeholder="e.g., photorealistic, flat illustration, watercolor"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="imageBrandColors">Image Brand Colors</Label>
                <Input
                  id="imageBrandColors"
                  value={imageBrandColors}
                  onChange={(e) => setImageBrandColors(e.target.value)}
                  placeholder="#FF5733, #33FF57, #3357FF"
                />
                <p className="text-[11px] text-muted-foreground">Comma-separated</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="imageExclude">Image Exclude</Label>
                <Input
                  id="imageExclude"
                  value={imageExclude}
                  onChange={(e) => setImageExclude(e.target.value)}
                  placeholder="text, watermarks, logos"
                />
                <p className="text-[11px] text-muted-foreground">Comma-separated</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Pipeline Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Default Stage Settings</CardTitle>
            <CardDescription>
              Default pipeline mode for new posts using this profile
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {STAGES.map((stage) => (
                <div
                  key={stage}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <span className="text-sm font-medium capitalize">{stage}</span>
                  <Select
                    value={stageSettings[stage]}
                    onValueChange={(v: StageMode) =>
                      setStageSettings((prev) => ({ ...prev, [stage]: v }))
                    }
                  >
                    <SelectTrigger className="w-[140px] h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STAGE_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          <span>{m.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-1.5" />
                Save Profile
              </>
            )}
          </Button>
        </div>
      </form>

      <Separator />

      {/* Crawl Sitemap */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Crawl Sitemap</CardTitle>
          <CardDescription>
            Crawl the website sitemap to discover internal links
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Status:</span>
              <Badge variant={CRAWL_STATUS_VARIANT[profile.crawl_status] || "secondary"}>
                {isCrawling && <Loader2 className="h-3 w-3 animate-spin" />}
                {profile.crawl_status}
              </Badge>
            </div>
            {profile.last_crawled_at && (
              <span className="text-xs text-muted-foreground">
                Last crawled:{" "}
                {new Date(profile.last_crawled_at).toLocaleString()}
              </span>
            )}
          </div>
          <div className="space-y-2">
            <Label>Re-crawl Schedule</Label>
            <Select value={recrawlInterval} onValueChange={setRecrawlInterval}>
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Automatically re-crawl the sitemap on a schedule. Saves with the profile.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCrawl}
            disabled={isCrawling}
          >
            {isCrawling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Crawling...
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Crawl Sitemap
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Internal Links */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Internal Links</CardTitle>
              <CardDescription>
                Links available for automatic insertion into blog posts
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddLink((prev) => !prev)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Link
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add Link Form */}
          {showAddLink && (
            <form
              onSubmit={handleAddLink}
              className="flex items-end gap-2 rounded-md border border-border p-3"
            >
              <div className="flex-1 space-y-1">
                <Label htmlFor="newLinkUrl" className="text-xs">
                  URL <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="newLinkUrl"
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  placeholder="https://example.com/page"
                  required
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label htmlFor="newLinkTitle" className="text-xs">
                  Title
                </Label>
                <Input
                  id="newLinkTitle"
                  value={newLinkTitle}
                  onChange={(e) => setNewLinkTitle(e.target.value)}
                  placeholder="Page title (optional)"
                />
              </div>
              <Button type="submit" size="sm" disabled={addingLink}>
                {addingLink ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Add"
                )}
              </Button>
            </form>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search links by URL or title..."
              value={linksSearch}
              onChange={(e) => {
                setLinksSearch(e.target.value);
                setLinksPage(1);
              }}
              className="pl-9"
            />
          </div>

          {/* Links Table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.length === 0 && !linksLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-muted-foreground py-8"
                    >
                      {linksSearch ? "No links match your search" : "No internal links yet"}
                    </TableCell>
                  </TableRow>
                ) : (
                  links.map((link) => (
                    <TableRow key={link.id}>
                      <TableCell className="max-w-[250px]">
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-600 hover:underline truncate block"
                        >
                          {link.url}
                        </a>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <span className="text-sm truncate block">
                          {link.title || "-"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            link.source === "sitemap"
                              ? "secondary"
                              : link.source === "manual"
                                ? "outline"
                                : "default"
                          }
                        >
                          {link.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(link.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleDeleteLink(link.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Load More / Loading */}
          {linksLoading && (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {linksHasMore && !linksLoading && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={handleLoadMore}>
                Load More
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
