"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
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
import { ProfileSelectCard } from "@/components/profile-select-card";
import { OutputFormatSelect } from "@/components/output-format-select";
import { PipelineGatesCard } from "@/components/pipeline-gates-card";
import { publishTargets, type FormatAvailabilityMap } from "@/lib/publishing";
import {
  apiErrorMessage,
  posts,
  profiles,
  type Profile,
  type PostCreate,
  type StageSettings,
  type WPCategory,
  type WPAuthor,
} from "@/lib/api";
import { toast } from "sonner";

const ARTICLE_TYPES = [
  { value: "guide", label: "Guide" },
  { value: "how-to", label: "How-To" },
  { value: "listicle", label: "Listicle" },
  { value: "review", label: "Review" },
  { value: "comparison", label: "Comparison" },
  { value: "news", label: "News" },
  { value: "opinion", label: "Opinion" },
];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export default function NewPostPage() {
  const router = useRouter();
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Form state
  const [topic, setTopic] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [intent, setIntent] = useState("");
  const [niche, setNiche] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [tone, setTone] = useState("Conversational and friendly");
  const [wordCount, setWordCount] = useState(2000);
  const [outputFormat, setOutputFormat] = useState("markdown");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [brandVoice, setBrandVoice] = useState("");
  const [avoid, setAvoid] = useState("");
  const [relatedKeywords, setRelatedKeywords] = useState("");
  const [competitorUrls, setCompetitorUrls] = useState("");
  // Null means "whatever the profile says", which is what decides whether the
  // body carries `stage_settings` at all: an omitted key inherits the
  // profile's gates, a submitted one is kept as sent (ledger item P2.114).
  const [stageSettings, setStageSettings] = useState<StageSettings | null>(null);
  const [wpCategoryId, setWpCategoryId] = useState<number | null>(null);
  const [wpAuthorId, setWpAuthorId] = useState<number | null>(null);
  const [articleType, setArticleType] = useState("");
  const [additionalInfo, setAdditionalInfo] = useState("");
  const [requiredMentions, setRequiredMentions] = useState("");
  const [wpCategories, setWpCategories] = useState<WPCategory[]>([]);
  const [wpAuthors, setWpAuthors] = useState<WPAuthor[]>([]);
  const [wpError, setWpError] = useState<string | null>(null);

  // Auto-slug from topic
  useEffect(() => {
    if (!slugManual && topic) {
      setSlug(slugify(topic));
    }
  }, [topic, slugManual]);

  /**
   * Category and author lists come from the profile's WordPress site, so a
   * wrong password or an unreachable host fails here and nowhere else. Left
   * silent it looks like a site with no categories.
   */
  const loadWpDefaults = async (profileId: string) => {
    setWpError(null);
    try {
      const [categories, authors] = await Promise.all([
        profiles.wpCategories(profileId),
        profiles.wpAuthors(profileId),
      ]);
      setWpCategories(categories);
      setWpAuthors(authors);
    } catch (e) {
      setWpCategories([]);
      setWpAuthors([]);
      setWpError(
        apiErrorMessage(e, "WordPress did not answer with categories or authors.")
      );
    }
  };

  const handleProfileSelect = (profile: Profile | null) => {
    setSelectedProfile(profile);
    // A gate override was made against the profile it was shown beside, so it
    // does not survive a different one: keeping it would silently apply one
    // site's gates to another's post.
    setStageSettings(null);
    if (profile) {
      setNiche(profile.niche || "");
      setTargetAudience(profile.target_audience || "");
      setTone(profile.tone || "Conversational and friendly");
      setWordCount(profile.word_count || 2000);
      setOutputFormat(profile.output_format || "markdown");
      setWebsiteUrl(profile.website_url || "");
      setBrandVoice(profile.brand_voice || "");
      setAvoid(profile.avoid || "");
      setRelatedKeywords((profile.related_keywords || []).join(", "));

      // Load WP data if profile has WordPress configured. All three
      // credentials, because `/wordpress/categories` answers a 400 without the
      // application password and the reason would land on the pickers as a
      // failure the user did not cause.
      setWpCategoryId(profile.wp_default_category_id);
      setWpAuthorId(profile.wp_default_author_id);
      if (publishTargets(profile).wordpress) {
        loadWpDefaults(profile.id);
      } else {
        setWpCategories([]);
        setWpAuthors([]);
        setWpError(null);
      }
    }
  };

  /**
   * Both publish steps read their credentials off the linked profile, so with
   * no profile chosen there is no destination at all, and with a
   * half-configured one there is a destination that fails after the pipeline
   * has already run. Named after the profile, because the form shows several
   * and the fix is on one of them.
   */
  const targets = publishTargets(selectedProfile);
  const formatAvailability: FormatAvailabilityMap = {
    wordpress: targets.wordpress
      ? { available: true }
      : {
          available: false,
          reason: selectedProfile
            ? `"${selectedProfile.name}" has no WordPress connection. Set one up in the profile.`
            : "Choose a website profile to publish there.",
        },
    nextjs: targets.nextjs
      ? { available: true }
      : {
          available: false,
          reason: selectedProfile
            ? `"${selectedProfile.name}" has no Next.js webhook. Set one up in the profile.`
            : "Choose a website profile to publish there.",
        },
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || !slug.trim()) {
      toast.error("Topic and slug are required");
      return;
    }
    // The endpoint refuses a post with no profile, because a post reaches its
    // owner only through one (ledger item P2.97). Said here rather than left to
    // the 422, which names a field the form does not label "profile_id".
    if (!selectedProfile) {
      toast.error("Pick a website profile first");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const data: PostCreate = {
        slug: slug.trim(),
        topic: topic.trim(),
        profile_id: selectedProfile.id,
        intent: intent || undefined,
        niche: niche || undefined,
        target_audience: targetAudience || undefined,
        tone,
        word_count: wordCount,
        output_format: outputFormat,
        website_url: websiteUrl || undefined,
        brand_voice: brandVoice || undefined,
        avoid: avoid || undefined,
        related_keywords: relatedKeywords
          ? relatedKeywords.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        competitor_urls: competitorUrls
          ? competitorUrls.split("\n").map((s) => s.trim()).filter(Boolean)
          : [],
        article_type: articleType || undefined,
        additional_info: additionalInfo || undefined,
        required_mentions: requiredMentions || undefined,
        wp_category_id: wpCategoryId,
        wp_author_id: wpAuthorId,
        ...(stageSettings ? { stage_settings: stageSettings } : {}),
      };
      const post = await posts.create(data);
      toast.success("Post created");
      router.push(`/posts/${post.id}`);
    } catch (e) {
      // Inline rather than a toast: the operator stays on a filled-in form
      // after a rejected slug or a dead database, so the reason has to stay
      // on screen next to the button that failed.
      setSubmitError(apiErrorMessage(e, "Failed to create post"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Post</h1>
          <p className="text-sm text-muted-foreground">
            Configure and create a new blog post
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <ProfileSelectCard
          description="Select a profile to auto-fill default settings"
          selected={selectedProfile}
          onSelect={handleProfileSelect}
        />

        {/* Required fields */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Content</CardTitle>
            <CardDescription>Topic and intent are the core inputs</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="topic">
                Topic <span className="text-destructive">*</span>
              </Label>
              <Input
                id="topic"
                placeholder="e.g., Best AR-15 Optics for Every Budget"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug <span className="text-destructive">*</span>
              </Label>
              <Input
                id="slug"
                placeholder="best-ar15-optics"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugManual(true);
                }}
                className="font-mono text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="intent">Search Intent</Label>
                <Select name="intent" value={intent} onValueChange={setIntent}>
                  <SelectTrigger id="intent">
                    <SelectValue placeholder="Select intent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="informational">Informational</SelectItem>
                    <SelectItem value="commercial">Commercial</SelectItem>
                    <SelectItem value="transactional">Transactional</SelectItem>
                    <SelectItem value="navigational">Navigational</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="articleType">Article Type</Label>
                <Select
                  name="article_type"
                  value={articleType}
                  onValueChange={setArticleType}
                >
                  <SelectTrigger id="articleType">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {ARTICLE_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                <Label htmlFor="audience">Target Audience</Label>
                <Input
                  id="audience"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  placeholder="e.g., Gun enthusiasts"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Writing config */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Writing Config</CardTitle>
            {/*
              Every field below arrives from the profile and is then editable,
              so the card owes the reader both facts: where the value came
              from, and that changing it here does not change the profile.
            */}
            <CardDescription>
              {selectedProfile
                ? `Filled in from "${selectedProfile.name}". Edits here apply to this post only.`
                : "How the article should read. Choose a profile above to fill these in."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
            <div className="grid grid-cols-2 gap-4">
              <OutputFormatSelect
                value={outputFormat}
                onValueChange={setOutputFormat}
                availability={formatAvailability}
              />
              <div className="space-y-2">
                <Label htmlFor="websiteUrl">Website URL</Label>
                <Input
                  id="websiteUrl"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="https://example.com"
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
            <div className="space-y-2">
              <Label htmlFor="avoid">Avoid</Label>
              <Input
                id="avoid"
                value={avoid}
                onChange={(e) => setAvoid(e.target.value)}
                placeholder="Words or phrases to avoid"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="requiredMentions">Required Mentions</Label>
              <Input
                id="requiredMentions"
                value={requiredMentions}
                onChange={(e) => setRequiredMentions(e.target.value)}
                placeholder="Topics, products, or links that must appear in the article"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="additionalInfo">Additional Information</Label>
              <Textarea
                id="additionalInfo"
                value={additionalInfo}
                onChange={(e) => setAdditionalInfo(e.target.value)}
                placeholder="Any additional context, requirements, or instructions for the AI..."
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* SEO */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">SEO & Research</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="keywords">Related Keywords</Label>
              <Input
                id="keywords"
                value={relatedKeywords}
                onChange={(e) => setRelatedKeywords(e.target.value)}
                placeholder="keyword1, keyword2, keyword3"
              />
              <p className="text-[11px] text-muted-foreground">
                Comma-separated. First keyword is treated as primary.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="competitors">Competitor URLs</Label>
              <Textarea
                id="competitors"
                value={competitorUrls}
                onChange={(e) => setCompetitorUrls(e.target.value)}
                placeholder="One URL per line"
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* WordPress Settings */}
        {selectedProfile?.wp_url && selectedProfile?.wp_username && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">WordPress Publishing</CardTitle>
              <CardDescription>
                Override category and author for this post
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {wpError && (
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-sm font-medium">
                      Could not load categories and authors
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{wpError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="mt-2"
                      onClick={() =>
                        selectedProfile && loadWpDefaults(selectedProfile.id)
                      }
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Retry
                    </Button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="wpCategory">Category</Label>
                  <Select
                    name="wp_category_id"
                    value={wpCategoryId?.toString() || "none"}
                    onValueChange={(v) =>
                      setWpCategoryId(v === "none" ? null : Number(v))
                    }
                  >
                    <SelectTrigger id="wpCategory">
                      <SelectValue placeholder="Profile default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Profile default</SelectItem>
                      {wpCategories.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wpAuthor">Author</Label>
                  <Select
                    name="wp_author_id"
                    value={wpAuthorId?.toString() || "none"}
                    onValueChange={(v) =>
                      setWpAuthorId(v === "none" ? null : Number(v))
                    }
                  >
                    <SelectTrigger id="wpAuthor">
                      <SelectValue placeholder="Profile default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Profile default</SelectItem>
                      {wpAuthors.map((a) => (
                        <SelectItem key={a.id} value={a.id.toString()}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/*
          Last, because it is the one card that describes the run rather than
          the article: everything above is an input to the six stages, this is
          what those stages will do with it.
        */}
        <PipelineGatesCard
          profile={selectedProfile}
          value={stageSettings}
          onChange={setStageSettings}
        />

        <Separator />

        {submitError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium">Could not create the post</p>
              <p className="mt-1 text-sm text-muted-foreground">{submitError}</p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          {!selectedProfile && (
            <p className="mr-auto text-sm text-muted-foreground">
              Pick a website profile to create this post.
            </p>
          )}
          <Link href="/">
            <Button variant="outline" type="button">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={submitting || !selectedProfile}>
            {submitting ? "Creating..." : "Create Post"}
          </Button>
        </div>
      </form>
    </div>
  );
}
