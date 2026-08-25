"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
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
  AlertCircle,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { CrawlStatusBadge } from "@/components/crawl-status-badge";
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
  apiErrorMessage,
  type Profile,
  type InternalLink,
  type StageMode,
  type PipelineStage,
  type WPCategory,
  type WPAuthor,
  STAGES,
} from "@/lib/api";
import {
  useDebouncedValue,
  SEARCH_DEBOUNCE_MS,
} from "@/hooks/use-debounced-value";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { STAGE_LABELS, STAGE_MODE_LABELS } from "@/lib/stages";
import { plainMessage } from "@/lib/plain-message";
import { OutputFormatSelect } from "@/components/output-format-select";
import { publishTargets, type FormatAvailabilityMap } from "@/lib/publishing";
import { toast } from "sonner";
import { ProfileDetailSkeleton } from "./profile-detail-skeleton";

/**
 * The four things a profile owns, one tab each, in the order of the ownership
 * table in `docs/polish/evidence/p3.md`: what the site is, where its finished
 * posts go, what a new post for it starts from, and its link inventory.
 */
const TABS = [
  { value: "site", label: "Site" },
  { value: "publishing", label: "Publishing" },
  { value: "defaults", label: "New post defaults" },
  { value: "links", label: "Internal links" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

const DEFAULT_TAB: TabValue = "site";

function isTabValue(value: string | null): value is TabValue {
  return TABS.some((tab) => tab.value === value);
}

/**
 * Read on mount only, off the History API rather than `useSearchParams`, which
 * would put a Suspense boundary requirement on a page that renders nothing on
 * the server anyway. A wrong or missing `?tab=` opens the first tab rather
 * than an empty page.
 */
function tabFromUrl(): TabValue {
  if (typeof window === "undefined") return DEFAULT_TAB;
  const named = new URLSearchParams(window.location.search).get("tab");
  return isTabValue(named) ? named : DEFAULT_TAB;
}

/** Ties the action bar to the form it submits without nesting it inside. */
const PROFILE_FORM_ID = "profile-form";

/**
 * What this picker offers, plus whatever the profile is already set to.
 *
 * All three modes are offered. Only `auto` was, for as long as nothing in the
 * dashboard could resume a suspended run: a gate switched on here parked the
 * post with no approve action anywhere to release it. `POST /api/posts/{id}/approve`
 * and the approval on the post page are that action, so the two waiting modes
 * are real settings again (ledger item P2.109b).
 *
 * The pipeline treats `review` and `approve_only` identically; both names are
 * kept because the column carries both and a profile written by the Python app
 * may hold either.
 */
const OFFERED_STAGE_MODES: StageMode[] = ["auto", "review", "approve_only"];

function stageModeOptions(current: StageMode | undefined): StageMode[] {
  // `default_stage_settings` is a bare JSON object on the wire, so a row that
  // names fewer than six stages reaches here with a hole in it. Prepending
  // that hole would put an option with no value in the list, and the picker is
  // not the place to guess what an unconfigured stage means.
  if (!current || OFFERED_STAGE_MODES.includes(current)) return OFFERED_STAGE_MODES;
  return [current, ...OFFERED_STAGE_MODES];
}

/**
 * What is actually known about a publishing destination. The page used to
 * derive "Connected" from two fields being non-empty, which reads Connected
 * beside a category picker that just failed to load with an authentication
 * error. Nothing here is inferred from a stored value: `connected` and
 * `failed` are the answers of a real test, and a destination that has
 * credentials but has not been tested says so.
 */
type ConnectionStatus =
  | { kind: "unconfigured" }
  | { kind: "untested" }
  | { kind: "checking" }
  | { kind: "connected"; siteName: string }
  | { kind: "failed"; reason: string };

const STATUS_LABELS: Record<ConnectionStatus["kind"], string> = {
  unconfigured: "Not configured",
  untested: "Not tested",
  checking: "Checking",
  connected: "Connected",
  failed: "Not connecting",
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const label = STATUS_LABELS[status.kind];
  if (status.kind === "connected") {
    return (
      <Badge variant="outline" className="text-green-600 border-green-600">
        {label}
      </Badge>
    );
  }
  if (status.kind === "failed") {
    return (
      <Badge variant="outline" className="text-destructive border-destructive">
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {status.kind === "checking" && (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      )}
      {label}
    </Badge>
  );
}

/**
 * The sentence under the fields. A failure is the reason the destination gave,
 * so it is an alert; everything else is the next thing to do.
 */
function ConnectionMessage({
  status,
  unconfigured,
  untested,
}: {
  status: ConnectionStatus;
  unconfigured: string;
  untested: string;
}) {
  if (status.kind === "failed") {
    return (
      <p role="alert" className="text-xs text-destructive">
        {status.reason}
      </p>
    );
  }
  const text =
    status.kind === "connected"
      ? `Connected to ${status.siteName}`
      : status.kind === "checking"
        ? "Checking the connection"
        : status.kind === "untested"
          ? untested
          : unconfigured;
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

export default function ProfileDetailPage() {
  const params = useParams();
  const profileId = params.id as string;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<TabValue>(tabFromUrl);

  /**
   * Written back with `replaceState` so the tab a user is on can be copied out
   * of the address bar and linked to, without the router round trip a
   * `router.replace` would cost on a page that fetches everything itself.
   */
  const selectTab = (value: string) => {
    if (!isTabValue(value)) return;
    setActiveTab(value);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.replaceState(window.history.state, "", url);
  };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const [outputFormat, setOutputFormat] = useState("markdown");
  const [imageStyle, setImageStyle] = useState("");
  const [imageBrandColors, setImageBrandColors] = useState("");
  const [imageExclude, setImageExclude] = useState("");
  const [avoid, setAvoid] = useState("");
  const [requiredMentions, setRequiredMentions] = useState("");
  const [relatedKeywords, setRelatedKeywords] = useState("");
  const [recrawlInterval, setRecrawlInterval] = useState<string>("disabled");
  const [stageSettings, setStageSettings] = useState<Record<PipelineStage, StageMode>>({
    research: "auto",
    outline: "auto",
    write: "auto",
    edit: "auto",
    images: "auto",
    ready: "auto",
  });

  // WordPress state
  const [wpUrl, setWpUrl] = useState("");
  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [wpDefaultStatus, setWpDefaultStatus] = useState("publish");
  const [wpDefaultCategoryId, setWpDefaultCategoryId] = useState<number | null>(null);
  const [wpDefaultAuthorId, setWpDefaultAuthorId] = useState<number | null>(null);
  const [wpCategories, setWpCategories] = useState<WPCategory[]>([]);
  const [wpAuthors, setWpAuthors] = useState<WPAuthor[]>([]);
  const [wpTesting, setWpTesting] = useState(false);
  const [wpListError, setWpListError] = useState<string | null>(null);
  const [wpStatus, setWpStatus] = useState<ConnectionStatus>({ kind: "unconfigured" });

  // Next.js state
  const [nextjsWebhookUrl, setNextjsWebhookUrl] = useState("");
  const [nextjsWebhookSecret, setNextjsWebhookSecret] = useState("");
  const [nextjsFrontmatterMap, setNextjsFrontmatterMap] = useState("");
  const [nextjsTesting, setNextjsTesting] = useState(false);
  const [nextjsStatus, setNextjsStatus] = useState<ConnectionStatus>({
    kind: "unconfigured",
  });

  // Links state
  const [links, setLinks] = useState<InternalLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [linksPage, setLinksPage] = useState(1);
  const [linksHasMore, setLinksHasMore] = useState(false);
  const [linksSearch, setLinksSearch] = useState("");
  // What the typist sees is `linksSearch`; what the server is asked for is
  // `linksQuery`, and what the rows on screen came from is `shownLinksSearch`.
  const linksQuery = useDebouncedValue(linksSearch, SEARCH_DEBOUNCE_MS);
  const [shownLinksSearch, setShownLinksSearch] = useState("");
  const beginLinksFetch = useLatestRequest();
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
    setOutputFormat(p.output_format || "markdown");
    setImageStyle(p.image_style || "");
    setImageBrandColors((p.image_brand_colors || []).join(", "));
    setImageExclude((p.image_exclude || []).join(", "));
    setAvoid(p.avoid || "");
    setRequiredMentions(p.required_mentions || "");
    setRelatedKeywords((p.related_keywords || []).join(", "));
    setRecrawlInterval(p.recrawl_interval || "disabled");
    setStageSettings(p.default_stage_settings);
    setWpUrl(p.wp_url || "");
    setWpUsername(p.wp_username || "");
    setWpAppPassword("");
    setWpDefaultStatus(p.wp_default_status || "publish");
    setWpDefaultCategoryId(p.wp_default_category_id);
    setWpDefaultAuthorId(p.wp_default_author_id);
    // All three credentials: `/wordpress/test` answers "credentials not
    // configured" without the application password, which is a failure the
    // user has not made yet rather than something to report.
    setWpStatus(
      publishTargets(p).wordpress ? { kind: "checking" } : { kind: "unconfigured" }
    );
    setNextjsWebhookUrl(p.nextjs_webhook_url || "");
    setNextjsWebhookSecret("");
    setNextjsFrontmatterMap(
      p.nextjs_frontmatter_map ? JSON.stringify(p.nextjs_frontmatter_map, null, 2) : ""
    );
    // Testing a webhook POSTs to the customer's site, so a stored URL can only
    // ever be untested here: the page will not fire it without being asked.
    setNextjsStatus(
      publishTargets(p).nextjs ? { kind: "untested" } : { kind: "unconfigured" }
    );
  }, []);

  const fetchProfile = useCallback(async () => {
    try {
      const data = await profiles.get(profileId);
      setProfile(data);
      setError(null);
      return data;
    } catch (e) {
      // The URL identifies the profile, so a failed load stays here with the
      // reason rather than bouncing back to the list and losing it.
      setError(
        apiErrorMessage(e, "The request failed and the server gave no reason.")
      );
      return null;
    }
  }, [profileId]);

  const fetchLinks = useCallback(
    async (page: number, search: string, append = false) => {
      setLinksLoading(true);
      // A search and the page it replaces can be in flight together, and the
      // older one answering last would write its rows over the newer ones.
      const isCurrent = beginLinksFetch();
      try {
        const data = await profiles.links(profileId, {
          page,
          per_page: LINKS_PER_PAGE,
          q: search || undefined,
        });
        if (!isCurrent()) return;
        if (append) {
          setLinks((prev) => [...prev, ...data.items]);
        } else {
          setLinks(data.items);
        }
        setLinksHasMore(page < data.pages);
        setShownLinksSearch(search);
        setLinksError(null);
      } catch (e) {
        if (!isCurrent()) return;
        setLinksError(
          apiErrorMessage(e, "The request failed and the server gave no reason.")
        );
      } finally {
        if (isCurrent()) setLinksLoading(false);
      }
    },
    [profileId, beginLinksFetch]
  );

  useEffect(() => {
    if (!loading) {
      setLinksPage(1);
      fetchLinks(1, linksQuery);
    }
  }, [loading, linksQuery, fetchLinks]);

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
            fetchLinks(1, linksQuery);
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
  }, [profile?.crawl_status, fetchProfile, fetchLinks, linksQuery]);

  /**
   * Read off the live form rather than off the loaded profile: the
   * credentials and the output format sit on the same unsaved form, so
   * anything else would make the user save twice to pick the destination they
   * just configured. `wp_app_password_set` covers the saved case, where the
   * ciphertext exists and the input is deliberately empty.
   */
  const credentialTargets = publishTargets({
    wp_url: wpUrl,
    wp_username: wpUsername,
    wp_app_password_set: Boolean(wpAppPassword) || Boolean(profile?.wp_app_password_set),
    nextjs_webhook_url: nextjsWebhookUrl,
    nextjs_webhook_secret_set:
      Boolean(nextjsWebhookSecret) || Boolean(profile?.nextjs_webhook_secret_set),
  });
  const formatAvailability: FormatAvailabilityMap = {
    wordpress: credentialTargets.wordpress
      ? { available: true }
      : {
          available: false,
          reason: "Fill in the WordPress card below to publish there.",
        },
    nextjs: credentialTargets.nextjs
      ? { available: true }
      : {
          available: false,
          reason: "Fill in the Next.js card below to publish there.",
        },
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !websiteUrl.trim()) {
      toast.error("Name and Website URL are required");
      return;
    }

    setSaving(true);
    setSaveError(null);
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
        wp_url: wpUrl || null,
        wp_username: wpUsername || null,
        ...(wpAppPassword ? { wp_app_password: wpAppPassword } : {}),
        wp_default_status: wpDefaultStatus,
        wp_default_category_id: wpDefaultCategoryId,
        wp_default_author_id: wpDefaultAuthorId,
        nextjs_webhook_url: nextjsWebhookUrl || null,
        ...(nextjsWebhookSecret ? { nextjs_webhook_secret: nextjsWebhookSecret } : {}),
        nextjs_frontmatter_map: nextjsFrontmatterMap
          ? (() => { try { return JSON.parse(nextjsFrontmatterMap); } catch { return null; } })()
          : null,
      };
      const updated = await profiles.update(profileId, data);
      setProfile(updated);
      toast.success("Profile saved");
    } catch (e) {
      // The form stays as the operator left it, so the reason belongs next to
      // the button they just pressed rather than in a toast that expires.
      setSaveError(apiErrorMessage(e, "The profile could not be saved."));
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

  const fetchWpData = useCallback(async () => {
    // Both endpoints answer a 502 carrying WordPress's own message when the
    // install rejects us, so an empty picker can say why. Swallowing it left a
    // profile whose application password had expired looking like a site with
    // no categories. `allSettled` because the two calls fail independently:
    // `list_users` needs a capability that `list_categories` does not.
    const [cats, auths] = await Promise.allSettled([
      profiles.wpCategories(profileId),
      profiles.wpAuthors(profileId),
    ]);
    const reasons: string[] = [];
    if (cats.status === "fulfilled") setWpCategories(cats.value);
    else {
      setWpCategories([]);
      reasons.push(
        plainMessage(apiErrorMessage(cats.reason, "Categories could not be loaded."))
      );
    }
    if (auths.status === "fulfilled") setWpAuthors(auths.value);
    else {
      setWpAuthors([]);
      reasons.push(
        plainMessage(apiErrorMessage(auths.reason, "Authors could not be loaded."))
      );
    }
    // One site, so both calls usually fail with the same sentence.
    setWpListError(reasons.length ? [...new Set(reasons)].join(" ") : null);
  }, [profileId]);

  /**
   * The one thing that decides what the WordPress badge says. `/wordpress/test`
   * is a read of `/wp-json`, so the page runs it on load as well as on demand;
   * every message it produces goes through `plainMessage` because WordPress
   * writes its REST errors for a browser.
   */
  const checkWpConnection = useCallback(async (): Promise<ConnectionStatus> => {
    setWpStatus({ kind: "checking" });
    let status: ConnectionStatus;
    try {
      const result = await profiles.wpTest(profileId);
      status = result.connected
        ? { kind: "connected", siteName: result.site_name || "WordPress" }
        : {
            kind: "failed",
            reason: plainMessage(
              result.error || "WordPress refused the connection and gave no reason."
            ),
          };
    } catch (e) {
      status = {
        kind: "failed",
        reason: plainMessage(
          apiErrorMessage(e, "The connection could not be tested and the server gave no reason.")
        ),
      };
    }
    setWpStatus(status);
    if (status.kind === "connected") {
      await fetchWpData();
    } else {
      // The pickers are read from the site, so there is nothing left to show.
      setWpCategories([]);
      setWpAuthors([]);
      setWpListError(null);
    }
    return status;
  }, [profileId, fetchWpData]);

  useEffect(() => {
    (async () => {
      const data = await fetchProfile();
      if (data) populateForm(data);
      setLoading(false);
      // A stored WordPress credential says nothing about whether it still
      // works, so the badge waits for the install to answer.
      if (data?.wp_url && data?.wp_username) await checkWpConnection();
    })();
  }, [fetchProfile, populateForm, checkWpConnection]);

  const handleWpTest = async () => {
    setWpTesting(true);
    try {
      // Save credentials first so the backend can use them
      const saveData: Record<string, unknown> = {
        wp_url: wpUrl || null,
        wp_username: wpUsername || null,
      };
      if (wpAppPassword) saveData.wp_app_password = wpAppPassword;
      await profiles.update(profileId, saveData);

      const status = await checkWpConnection();
      if (status.kind === "connected") {
        toast.success(`Connected to ${status.siteName}`);
      } else if (status.kind === "failed") {
        toast.error(status.reason);
      }
    } catch (e) {
      // The credentials are saved before they are tested, so the profile
      // boundary can refuse the URL before WordPress is ever reached. Its
      // reason is the one that tells the operator what to change.
      const reason = apiErrorMessage(e, "The connection could not be tested.");
      setWpStatus({ kind: "failed", reason });
      toast.error(reason);
    } finally {
      setWpTesting(false);
    }
  };

  const handleNextjsTest = async () => {
    setNextjsTesting(true);
    setNextjsStatus({ kind: "checking" });
    try {
      // Save webhook URL first so the backend can use it
      const saveData: Record<string, unknown> = {
        nextjs_webhook_url: nextjsWebhookUrl || null,
      };
      if (nextjsWebhookSecret) saveData.nextjs_webhook_secret = nextjsWebhookSecret;
      await profiles.update(profileId, saveData);

      const result = await profiles.nextjsTest(profileId);
      if (result.connected) {
        setNextjsStatus({ kind: "connected", siteName: "the webhook" });
        toast.success("Next.js webhook connected");
      } else {
        // A non-200 carries the first 200 characters of the response body,
        // which for a wrong URL is usually an HTML error page.
        const reason = plainMessage(
          result.error || "The webhook refused the request and gave no reason."
        );
        setNextjsStatus({ kind: "failed", reason });
        toast.error(reason);
      }
    } catch (e) {
      // Same shape as the WordPress test above: the webhook URL is saved
      // before it is called, so a rejected save is the failure to report.
      const reason = apiErrorMessage(e, "The webhook could not be tested.");
      setNextjsStatus({ kind: "failed", reason });
      toast.error(reason);
    } finally {
      setNextjsTesting(false);
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
      fetchLinks(1, linksQuery);
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
    fetchLinks(nextPage, linksQuery, true);
  };

  if (loading) return <ProfileDetailSkeleton />;

  if (!profile) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div>
          <Link href="/profiles">
            <Button variant="ghost" size="sm" className="-ml-2">
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Profiles
            </Button>
          </Link>
        </div>
        <div className="flex flex-col items-center justify-center rounded-md border border-border py-16 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="mt-3 text-sm font-medium">Could not load this profile</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {error ?? "The request failed and the server gave no reason."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => {
              setLoading(true);
              (async () => {
                const data = await fetchProfile();
                if (data) populateForm(data);
                setLoading(false);
              })();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const isCrawling = profile.crawl_status === "crawling";

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* A refetch that failed while a good render is on screen: the page keeps
          showing the last known profile and says so rather than replacing it. */}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              This profile could not be refreshed
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchProfile}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      )}

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
          {/* This page owns one site. The three things it does not own are
              named here rather than left for a user to hunt for under a nav
              item called Settings. */}
          <p className="mt-1 text-sm text-muted-foreground">
            API keys, stage models and rule files are account-wide:{" "}
            <Link
              href="/settings"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Account settings
            </Link>
            .
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={selectTab} className="gap-6">
        <TabsList>
          {TABS.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/*
          One form across three of the four tabs, submitted by the action bar
          below. Every field is React state rather than an uncontrolled input,
          so a tab the user has left keeps its edits and saves with the rest.
        */}
        <form id={PROFILE_FORM_ID} onSubmit={handleSave} className="space-y-6">
          <TabsContent value="site" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Site</CardTitle>
                <CardDescription>
                  Which site this profile writes for, and who it writes for.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">
                      Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="name"
                      /* The profile's name, not the operator's: browser autofill
                         recognises `name` and would offer a person's name here. */
                      autoComplete="off"
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Voice</CardTitle>
                <CardDescription>
                  How every post for this site should read. The writing stages
                  are given this as written.
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
                  <Label htmlFor="requiredMentions">Required Mentions</Label>
                  <Input
                    id="requiredMentions"
                    value={requiredMentions}
                    onChange={(e) => setRequiredMentions(e.target.value)}
                    placeholder="Brands, products, or phrases that must be mentioned"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="publishing" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Destination</CardTitle>
                <CardDescription>
                  Where a finished post for this site goes. A post can be
                  switched to a different destination before it runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <OutputFormatSelect
                  value={outputFormat}
                  onValueChange={setOutputFormat}
                  availability={formatAvailability}
                />
              </CardContent>
            </Card>

            {/* WordPress Integration */}
            {/*
              Rendered whatever the output format is. Gating it on
              `outputFormat === "wordpress"` left a profile that had never picked
              WordPress with nowhere to enter a connection, and the new-post form's
              `wordpress` option with nothing to check against.
            */}
            <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">WordPress</CardTitle>
                    <ConnectionBadge status={wpStatus} />
                  </div>
                  <CardDescription>
                    Publish straight to a WordPress site when the pipeline finishes
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="wpUrl">WordPress URL</Label>
                      <Input
                        id="wpUrl"
                        value={wpUrl}
                        onChange={(e) => setWpUrl(e.target.value)}
                        placeholder="https://yoursite.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="wpUsername">Username</Label>
                      <Input
                        id="wpUsername"
                        value={wpUsername}
                        onChange={(e) => setWpUsername(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="wpAppPassword">Application Password</Label>
                      <Input
                        id="wpAppPassword"
                        type="password"
                        value={wpAppPassword}
                        onChange={(e) => setWpAppPassword(e.target.value)}
                        placeholder={
                          wpStatus.kind === "unconfigured"
                            ? "Enter app password"
                            : "(unchanged)"
                        }
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Generate in WordPress &gt; Users &gt; Application Passwords
                      </p>
                    </div>
                    <div className="flex flex-col justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={handleWpTest}
                        disabled={wpTesting || !wpUrl || !wpUsername}
                      >
                        {wpTesting ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Test connection
                      </Button>
                      <ConnectionMessage
                        status={wpStatus}
                        unconfigured="Enter the site URL, a username and an application password, then test the connection."
                        untested="Test the connection to check these credentials."
                      />
                    </div>
                  </div>

                  {wpStatus.kind === "connected" && (
                    <>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="wpDefaultCategory">Default Category</Label>
                          <Select
                            name="wp_default_category_id"
                            value={wpDefaultCategoryId?.toString() || "none"}
                            onValueChange={(v) =>
                              setWpDefaultCategoryId(v === "none" ? null : Number(v))
                            }
                          >
                            <SelectTrigger id="wpDefaultCategory">
                              <SelectValue placeholder="Select category" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {wpCategories.map((c) => (
                                <SelectItem key={c.id} value={c.id.toString()}>
                                  {c.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="wpDefaultAuthor">Default Author</Label>
                          <Select
                            name="wp_default_author_id"
                            value={wpDefaultAuthorId?.toString() || "none"}
                            onValueChange={(v) =>
                              setWpDefaultAuthorId(v === "none" ? null : Number(v))
                            }
                          >
                            <SelectTrigger id="wpDefaultAuthor">
                              <SelectValue placeholder="Select author" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {wpAuthors.map((a) => (
                                <SelectItem key={a.id} value={a.id.toString()}>
                                  {a.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="wpDefaultStatus">Default Status</Label>
                          <Select
                            name="wp_default_status"
                            value={wpDefaultStatus}
                            onValueChange={setWpDefaultStatus}
                          >
                            <SelectTrigger id="wpDefaultStatus">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="publish">Publish</SelectItem>
                              <SelectItem value="draft">Draft</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {wpListError && (
                        <p role="alert" className="text-xs text-destructive">
                          {wpListError}
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

            {/* Next.js Integration */}
            <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">Next.js</CardTitle>
                    <ConnectionBadge status={nextjsStatus} />
                  </div>
                  <CardDescription>
                    Publish to a Next.js site over a webhook when the pipeline finishes
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="nextjsWebhookUrl">Webhook URL</Label>
                    <Input
                      id="nextjsWebhookUrl"
                      value={nextjsWebhookUrl}
                      onChange={(e) => setNextjsWebhookUrl(e.target.value)}
                      placeholder="https://yoursite.com/api/jena-webhook"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="nextjsWebhookSecret">Webhook Secret</Label>
                      <Input
                        id="nextjsWebhookSecret"
                        type="password"
                        value={nextjsWebhookSecret}
                        onChange={(e) => setNextjsWebhookSecret(e.target.value)}
                        placeholder={
                          nextjsStatus.kind === "unconfigured"
                            ? "Enter webhook secret"
                            : "(unchanged)"
                        }
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Shared secret for HMAC signature verification
                      </p>
                    </div>
                    <div className="flex flex-col justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={handleNextjsTest}
                        disabled={nextjsTesting || !nextjsWebhookUrl}
                      >
                        {nextjsTesting ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Test webhook
                      </Button>
                      <ConnectionMessage
                        status={nextjsStatus}
                        unconfigured="Enter the webhook URL and shared secret, then test it."
                        untested="Test the webhook to check that the site answers."
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nextjsFrontmatterMap">Frontmatter Mapping</Label>
                    <Textarea
                      id="nextjsFrontmatterMap"
                      value={nextjsFrontmatterMap}
                      onChange={(e) => setNextjsFrontmatterMap(e.target.value)}
                      placeholder='{"category": "blog", "author": "Jena AI"}'
                      rows={4}
                      className="font-mono text-sm"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      JSON object of extra frontmatter fields to include in published posts.
                      These are merged with the default frontmatter (title, slug, date, etc.).
                    </p>
                  </div>
                </CardContent>
              </Card>
          </TabsContent>

          <TabsContent value="defaults" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Article Defaults</CardTitle>
                <CardDescription>
                  What a new post for this site starts with. Each one can be
                  changed on the post itself.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
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
                  Where a run pauses for review. Copied onto every post created
                  from this profile, in New Post and Batch Create. The model
                  each stage runs on is a different setting,{" "}
                  <Link
                    href="/settings"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    set once for the account
                  </Link>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {STAGES.map((stage) => (
                    <div
                      key={stage}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                    >
                      <span className="text-sm font-medium">{STAGE_LABELS[stage]}</span>
                      <Select
                        name={`stage_${stage}`}
                        value={stageSettings[stage]}
                        onValueChange={(v: StageMode) =>
                          setStageSettings((prev) => ({ ...prev, [stage]: v }))
                        }
                      >
                        <SelectTrigger
                          // Wide enough for the longest mode name. At 140px
                          // `line-clamp-1` cut "Run automatically" mid-word.
                          className="w-[180px] h-8"
                          aria-label={`${STAGE_LABELS[stage]} stage mode`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {stageModeOptions(stageSettings[stage]).map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              <span>{STAGE_MODE_LABELS[mode]}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </form>

        {/* The links inventory is this site's data, not its settings, so it
            sits outside the profile form. The crawl card's Re-crawl Schedule
            is a profile field and is saved by the action bar below, which is
            why that bar is bound to the form by id rather than nested in it. */}
        <TabsContent value="links" className="space-y-6">
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
                  <CrawlStatusBadge status={profile.crawl_status} />
                </div>
                {profile.last_crawled_at && (
                  <span className="text-xs text-muted-foreground">
                    Last crawled:{" "}
                    {new Date(profile.last_crawled_at).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="recrawlInterval">Re-crawl Schedule</Label>
                <Select
                  name="recrawl_interval"
                  value={recrawlInterval}
                  onValueChange={setRecrawlInterval}
                >
                  <SelectTrigger id="recrawlInterval" className="w-[200px]">
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
                  name="link-search"
                  aria-label="Search internal links"
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
                    {linksLoading && links.length === 0 ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                          <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                        </TableRow>
                      ))
                    ) : linksError ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="h-32 text-center">
                          <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
                          <p className="mt-2 text-sm font-medium">
                            Could not load internal links
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {linksError}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            onClick={() => fetchLinks(1, linksQuery)}
                          >
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                            Retry links
                          </Button>
                        </TableCell>
                      </TableRow>
                    ) : links.length === 0 ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="h-32 text-center">
                          {shownLinksSearch ? (
                            <>
                              <p className="text-sm font-medium">
                                No links match your search
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                className="mt-3"
                                onClick={() => setLinksSearch("")}
                              >
                                Clear search
                              </Button>
                            </>
                          ) : (
                            <>
                              <p className="text-sm font-medium">
                                No internal links yet
                              </p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                Crawl the sitemap or add a link by hand to give the
                                pipeline something to link to.
                              </p>
                            </>
                          )}
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
              {linksLoading && links.length > 0 && (
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
        </TabsContent>

        <div className="sticky bottom-0 z-10 -mx-6 space-y-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
          {saveError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Could not save this profile</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{saveError}</p>
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" form={PROFILE_FORM_ID} disabled={saving}>
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
        </div>
      </Tabs>
    </div>
  );
}
