"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
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
import {
  posts,
  profiles,
  type Profile,
  type PostCreate,
  type WPCategory,
  type WPAuthor,
} from "@/lib/api";
import { toast } from "sonner";

const OUTPUT_FORMATS = [
  { value: "markdown", label: "Markdown" },
  { value: "wordpress", label: "WordPress (Direct Publish)" },
];

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
  const [profileList, setProfileList] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
  const [wpCategoryId, setWpCategoryId] = useState<number | null>(null);
  const [wpAuthorId, setWpAuthorId] = useState<number | null>(null);
  const [articleType, setArticleType] = useState("");
  const [additionalInfo, setAdditionalInfo] = useState("");
  const [requiredMentions, setRequiredMentions] = useState("");
  const [wpCategories, setWpCategories] = useState<WPCategory[]>([]);
  const [wpAuthors, setWpAuthors] = useState<WPAuthor[]>([]);

  useEffect(() => {
    profiles.list().then(setProfileList).catch(() => {});
  }, []);

  // Auto-slug from topic
  useEffect(() => {
    if (!slugManual && topic) {
      setSlug(slugify(topic));
    }
  }, [topic, slugManual]);

  const handleProfileChange = (profileId: string) => {
    const profile = profileList.find((p) => p.id === profileId) || null;
    setSelectedProfile(profile);
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

      // Load WP data if profile has WordPress configured
      setWpCategoryId(profile.wp_default_category_id);
      setWpAuthorId(profile.wp_default_author_id);
      if (profile.wp_url && profile.wp_username) {
        profiles.wpCategories(profile.id).then(setWpCategories).catch(() => {});
        profiles.wpAuthors(profile.id).then(setWpAuthors).catch(() => {});
      } else {
        setWpCategories([]);
        setWpAuthors([]);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || !slug.trim()) {
      toast.error("Topic and slug are required");
      return;
    }

    setSubmitting(true);
    try {
      const data: PostCreate = {
        slug: slug.trim(),
        topic: topic.trim(),
        profile_id: selectedProfile?.id || undefined,
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
      };
      const post = await posts.create(data);
      toast.success("Post created");
      router.push(`/posts/${post.id}`);
    } catch {
      toast.error("Failed to create post");
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
        {/* Profile selector */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Website Profile</CardTitle>
            <CardDescription>
              Select a profile to auto-fill default settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={selectedProfile?.id || "none"}
              onValueChange={(v) =>
                v === "none" ? setSelectedProfile(null) : handleProfileChange(v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="No profile (manual config)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No profile</SelectItem>
                {profileList.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

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
                <Select value={intent} onValueChange={setIntent}>
                  <SelectTrigger>
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
                <Select value={articleType} onValueChange={setArticleType}>
                  <SelectTrigger>
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
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select
                    value={wpCategoryId?.toString() || "none"}
                    onValueChange={(v) =>
                      setWpCategoryId(v === "none" ? null : Number(v))
                    }
                  >
                    <SelectTrigger>
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
                  <Label>Author</Label>
                  <Select
                    value={wpAuthorId?.toString() || "none"}
                    onValueChange={(v) =>
                      setWpAuthorId(v === "none" ? null : Number(v))
                    }
                  >
                    <SelectTrigger>
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

        <Separator />

        <div className="flex justify-end gap-3">
          <Link href="/">
            <Button variant="outline" type="button">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create Post"}
          </Button>
        </div>
      </form>
    </div>
  );
}
