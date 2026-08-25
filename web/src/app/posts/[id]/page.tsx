"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  PauseCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Pause,
  Copy,
  ExternalLink,
  Loader2,
  Upload,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { PipelineProgress } from "@/components/pipeline-progress";
import { RunStateBadge } from "@/components/run-state-badge";
import { MarkdownEditor } from "@/components/markdown-editor";
import { ContentPreview } from "@/components/content-preview";
import {
  AnalyticsBar,
  SeoChecklist,
  KeywordDensity,
} from "@/components/analytics-bar";
import { ImagePreview } from "@/components/image-preview";
import { ExportButton } from "@/components/export-button";
import { DebugLogPanel, type DebugLog } from "@/components/debug-log-panel";
import { RunTrace } from "@/components/run-trace";
import { PostDetailSkeleton } from "./post-detail-skeleton";
import {
  apiErrorMessage,
  posts,
  type Post,
  type PipelineStage,
  type PostStage,
  type PostAnalytics,
  STAGES,
} from "@/lib/api";
import { STAGE_LABELS, stageLabel } from "@/lib/stages";
import { deriveRunState, resumeStage } from "@/lib/run-state";
import { buildRunTrace, type LiveImage } from "@/lib/run-trace";
import { lastPublishError } from "@/lib/publish-report";
import { PUBLISH_TARGET_LABELS, publishTargetOf } from "@/lib/publishing";
import { plainMessage } from "@/lib/plain-message";
import { useSSE, type SSEEvent } from "@/hooks/use-sse";
import { toast } from "sonner";

const STAGE_CONTENT_FIELDS: Record<PipelineStage, keyof Post> = {
  research: "research_content",
  outline: "outline_content",
  write: "draft_content",
  edit: "final_md_content",
  images: "image_manifest",
  ready: "ready_content",
};

const STAGE_UPDATE_FIELDS: Record<PipelineStage, string> = {
  research: "research_content",
  outline: "outline_content",
  write: "draft_content",
  edit: "final_md_content",
  images: "image_manifest",
  ready: "ready_content",
};

export default function PostDetailPage() {
  const params = useParams();
  const postId = params.id as string;

  const [post, setPost] = useState<Post | null>(null);
  const [analytics, setAnalytics] = useState<PostAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("research");
  const [editorContent, setEditorContent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  // The stage of the most recent `stage_start` frame. The row entry that frame
  // announces is not on the client until the next refetch, and refetches only
  // happen on terminal stage events, so without this the trace's elapsed clock
  // would sit blank for the whole of the stage it is timing.
  const [liveStart, setLiveStart] = useState<{ stage: PipelineStage; at: string } | null>(null);
  // Every per-image outcome this page has seen since the `images` stage last
  // started. The fan-out publishes one line per manifest entry and the row is
  // not refetched until the stage ends, so this is the only account of the
  // stage's progress while it is the stage in flight.
  const [liveImages, setLiveImages] = useState<LiveImage[]>([]);
  const lastSavedRef = useRef<string>("");

  /**
   * A failed load used to raise a toast and push the browser back to `/`, so a
   * 500 or a dropped connection took the operator off the post with nothing to
   * read and nothing to retry. It now leaves the page where it is and shows the
   * server's own message: as a full-page state when there is no post to show,
   * and as a banner over the last good render when a refetch fails mid-run.
   */
  const fetchPost = useCallback(async () => {
    try {
      const data = await posts.get(postId);
      setError(null);
      setPost((prev) => {
        if (!prev) return data;
        // Preserve optimistic "running" when API returns stale "pending"
        const mergedStatus = { ...data.stage_status };
        let hasPreserved = false;
        for (const stage of STAGES) {
          if (prev.stage_status[stage] === "running" && mergedStatus[stage] === "pending") {
            mergedStatus[stage] = "running";
            hasPreserved = true;
          }
        }
        if (!hasPreserved) return data;
        return { ...data, stage_status: mergedStatus, current_stage: prev.current_stage };
      });
      const lastComplete = [...STAGES]
        .reverse()
        .find((s) => data.stage_status[s] === "complete");
      if (lastComplete) setActiveTab(lastComplete);
    } catch (e) {
      // A route handler that dies before it can answer sends an empty 500
      // body, so there is often nothing of the server's own to show.
      setError(
        apiErrorMessage(e, "The request failed and the server gave no reason.")
      );
    } finally {
      setLoading(false);
    }
  }, [postId]);

  const fetchAnalytics = useCallback(async () => {
    try {
      const data = await posts.analytics(postId);
      setAnalytics(data);
      setAnalyticsError(null);
    } catch (e) {
      setAnalyticsError(
        apiErrorMessage(e, "The request failed and the server gave no reason.")
      );
    }
  }, [postId]);

  useEffect(() => {
    fetchPost();
    fetchAnalytics();
  }, [fetchPost, fetchAnalytics]);

  // Sync editor content when tab changes or post loads
  useEffect(() => {
    if (!post) return;
    const stage = activeTab as PipelineStage;
    const field = STAGE_CONTENT_FIELDS[stage];
    if (field && stage !== "images" && stage !== "ready") {
      const content = (post[field] as string) || "";
      setEditorContent(content);
      lastSavedRef.current = content;
    }
  }, [activeTab, post]);

  // SSE for real-time updates
  const handleSSE = useCallback(
    (event: SSEEvent) => {
      if (event.post_id !== postId) return;

      const debugEvents = [
        "stage_start",
        "stage_complete",
        "stage_error",
        "log",
        "pipeline_complete",
        // The fan-out's own lines. They carry their message and their level
        // with them, so they read in the panel the way the stored trail reads.
        "image_generated",
        "image_failed",
      ];
      if (debugEvents.includes(event.event)) {
        const log: DebugLog = {
          event: event.event,
          stage: event.stage as string | undefined,
          message: event.message as string | undefined,
          level: event.level as string | undefined,
          timestamp: (event.timestamp as string) || new Date().toISOString(),
          model: event.model as string | undefined,
          tokens_in: event.tokens_in as number | undefined,
          tokens_out: event.tokens_out as number | undefined,
          duration_s: event.duration_s as number | undefined,
          error: event.error as string | undefined,
        };

        // Clear logs when a new run starts
        if (event.event === "stage_start") {
          setDebugLogs((prev) => {
            const hasPipelineComplete = prev.some((l) => l.event === "pipeline_complete");
            return hasPipelineComplete ? [log] : [...prev, log];
          });
        } else {
          setDebugLogs((prev) => [...prev, log]);
        }
      }

      if (event.event === "image_generated" || event.event === "image_failed") {
        const index = (event.data as { index?: unknown } | undefined)?.index;
        setLiveImages((prev) => [
          ...prev,
          {
            index: typeof index === "number" ? index : null,
            outcome: event.event === "image_generated" ? "generated" : "failed",
          },
        ]);
      }

      if (event.event === "stage_start" && event.stage) {
        setLiveStart({ stage: event.stage as PipelineStage, at: new Date().toISOString() });
        // A stage that starts again generates its images again, so the frames
        // from the attempt before it are not this attempt's progress.
        if (event.stage === "images") setLiveImages([]);
        // Optimistically show this stage as "running" in the progress UI
        setPost((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            current_stage: event.stage as PostStage,
            stage_status: {
              ...prev.stage_status,
              [event.stage as string]: "running" as const,
            },
          };
        });
      }

      // `stage_review` is here for the same reason the other three are, and
      // it is the one that was missing: a run that parks at a gate publishes
      // nothing else, and this page has no poll, so the approval below stayed
      // invisible until the reader reloaded by hand.
      if (
        event.event === "stage_complete" ||
        event.event === "stage_error" ||
        event.event === "stage_review" ||
        event.event === "pipeline_complete"
      ) {
        fetchPost();
      }
      // No toast here. `GlobalNotifications` is mounted from the root layout,
      // so it is open on this page too and announces both of these off the
      // queue-wide feed, naming the stage the way the rest of the UI does.
      // Raising a second one here meant two notifications per event, one of
      // them worded "research complete".
      if (event.event === "stage_complete") {
        fetchAnalytics();
      }
      if (event.event === "publish_start") {
        const target = (event as Record<string, unknown>).target;
        if (target === "nextjs") {
          toast.info("Publishing to Next.js...");
          setPost((prev) => prev ? { ...prev, nextjs_publish_status: "publishing" } : prev);
        } else {
          toast.info("Publishing to WordPress...");
          setPost((prev) => prev ? { ...prev, wp_publish_status: "publishing" } : prev);
        }
      }
      if (event.event === "publish_complete") {
        const target = (event as Record<string, unknown>).target;
        toast.success(target === "nextjs" ? "Published to Next.js!" : "Published to WordPress!");
        fetchPost();
      }
      if (event.event === "publish_error") {
        const raw = (event as Record<string, unknown>).error;
        // WordPress writes its REST errors for a browser; the refetch below
        // renders the same reason off the row through the same cleaner.
        const error = typeof raw === "string" ? plainMessage(raw) : "";
        toast.error(error || "The publish failed and reported no reason.", {
          duration: 8000,
        });
        fetchPost();
      }
    },
    [postId, fetchPost, fetchAnalytics]
  );

  useSSE(postId, handleSSE);

  const handleSave = useCallback(
    async (value: string) => {
      if (!post || value === lastSavedRef.current) return;
      const stage = activeTab as PipelineStage;
      const field = STAGE_UPDATE_FIELDS[stage];
      if (!field || stage === "images" || stage === "ready") return;

      setSaving(true);
      try {
        await posts.update(postId, { [field]: value } as Record<string, string>);
        lastSavedRef.current = value;
        fetchAnalytics();
      } catch {
        toast.error("Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [post, activeTab, postId, fetchAnalytics]
  );

  const handlePause = async () => {
    try {
      await posts.pause(postId);
      toast.success("Paused");
      fetchPost();
    } catch (e) {
      toast.error(apiErrorMessage(e, "The run could not be paused."));
    }
  };

  /**
   * The action behind the empty state. `POST /run` with no stage starts a full
   * pipeline that skips whatever is already complete and still parks on the
   * post's configured review gates, which is what "run this post" means for a
   * post that has never run; `/run-all` would force every gate to `auto`.
   */
  const handleRun = async () => {
    try {
      await posts.run(postId);
      toast.success("Pipeline started");
      fetchPost();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to start the pipeline"));
    }
  };

  /**
   * The header's resume. `POST /rerun` restarts the whole pipeline from the
   * first stage `stage_status` does not call complete, which is why the button
   * names that stage rather than saying "stage": the per-stage retry beside a
   * failed stage is `handleRetryStage`, it is a different action, and the old
   * "Rerun Stage" label read as that one.
   */
  const handleRerun = async () => {
    try {
      const result = await posts.rerun(postId);
      toast.success(`Re-running from ${stageLabel(result.rerun_from)}`);
      fetchPost();
    } catch (e) {
      toast.error(apiErrorMessage(e, "The re-run could not be started."));
    }
  };

  /**
   * The retry behind a failed stage. `POST /run?stage=<stage>` runs that stage
   * alone, which is the only retry the API offers: there is no finer grain, so
   * one failed image and five failed images take the same action. Item P1.2a is
   * what makes it reach the worker at all, because a stage `stage_status` still
   * called complete was skipped by `shouldRunStage`.
   */
  const handleRetryStage = async (stage: PipelineStage) => {
    const name = STAGE_LABELS[stage];
    try {
      await posts.run(postId, stage);
      toast.success(`Re-running ${name}`);
      fetchPost();
    } catch (e) {
      toast.error(apiErrorMessage(e, `Failed to re-run the ${name} stage`));
    }
  };

  const handleRetryImages = () => handleRetryStage("images");

  /**
   * Release the run parked at a review gate. This is the only action on the
   * page that continues the run that is already waiting: `/run` and `/rerun`
   * both start a *new* one and leave the parked run suspended forever, which
   * is what ledger item P2.109 records.
   *
   * A 409 is not a failure the user caused. It is what a second click looks
   * like, and what an approval made in another tab looks like, so it refetches
   * rather than shouting.
   */
  const handleApprove = async (stage: PipelineStage) => {
    const name = STAGE_LABELS[stage];
    try {
      const released = await posts.approve(postId);
      toast.success(`${STAGE_LABELS[released.stage]} approved`);
    } catch (e) {
      toast.error(apiErrorMessage(e, `The ${name} stage could not be approved.`));
    } finally {
      fetchPost();
    }
  };

  /**
   * `POST /restart` clears all six content columns plus `final_html_content`
   * and `stage_logs`, then runs from `research`. Nothing about that is
   * recoverable, and the old "Force Restart" label named the force rather than
   * the loss, so the confirmation below is what actually says it.
   */
  const handleRestart = async () => {
    setConfirmingRestart(false);
    try {
      await posts.restart(postId);
      toast.success("Starting over from Research");
      fetchPost();
    } catch (e) {
      toast.error(apiErrorMessage(e, "The run could not be started over."));
    }
  };

  /**
   * `POST /api/posts/{id}/publish` queues the run and answers 202; the worker
   * is what publishes. So the optimistic write here is `pending`, which is the
   * status the handler actually stored, and not `publishing`, which only the
   * publish step sets once it has the credentials in hand. Claiming
   * `publishing` made a post whose worker never picked the event up read
   * "Publishing..." forever.
   *
   * The refusals are ordinary and worth reading: no content on the post, or an
   * `output_format` no publish step handles.
   */
  const handlePublish = async () => {
    const target = post?.output_format === "nextjs" ? "Next.js" : "WordPress";
    try {
      await posts.publish(postId);
      toast.info(`Queued to publish to ${target}.`);
      setPost((prev) => {
        if (!prev) return prev;
        return prev.output_format === "nextjs"
          ? { ...prev, nextjs_publish_status: "pending" }
          : { ...prev, wp_publish_status: "pending" };
      });
    } catch (e) {
      toast.error(apiErrorMessage(e, `Could not start publishing to ${target}.`));
    }
  };

  const copyContent = (content: string) => {
    navigator.clipboard.writeText(content);
    toast.success("Copied to clipboard");
  };

  const retry = () => {
    setLoading(true);
    fetchPost();
    fetchAnalytics();
  };

  if (loading) return <PostDetailSkeleton />;

  if (!post) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <Link href="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            All posts
          </Button>
        </Link>
        <Card className="py-0">
          <CardContent className="py-16 text-center">
            <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
            <p className="mt-3 text-base font-medium">Could not load this post</p>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
              {error ?? "The request failed and the server gave no reason."}
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={retry}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isRunning = STAGES.some((s) => post.stage_status[s] === "running");
  const isComplete = post.current_stage === "complete";
  // The two columns read together, which is the only way to tell a run that
  // finished from one that finished without its pictures: `markPipelineComplete()`
  // stamps `complete` unconditionally. See `src/lib/run-state.ts`.
  const runState = deriveRunState({
    currentStage: post.current_stage,
    stageStatus: post.stage_status,
  });
  // What each failed stage actually reported, folded out of the same
  // `execution_logs` column the run trace below reads, so the banner and the
  // trace cannot disagree about the reason.
  const stageFailures = runState.failedStages.map((stage) => {
    const row = buildRunTrace({
      entries: post.execution_logs,
      stageStatus: post.stage_status,
    }).stages.find((s) => s.stage === stage);
    return {
      stage,
      reason:
        row?.error ?? "The run recorded no reason. The worker log has the detail.",
    };
  });
  // The destination this post's `output_format` names, and what the last
  // attempt at it did. The two status columns are independent and neither
  // publish step clears the other, so a post that changed format can still
  // carry its old destination's status; the format is what decides which one
  // this page speaks about.
  const target = publishTargetOf(post.output_format);
  const publishTarget = target
    ? {
        target,
        label: PUBLISH_TARGET_LABELS[target],
        status:
          target === "wordpress" ? post.wp_publish_status : post.nextjs_publish_status,
      }
    : null;
  // Gated on the status column, not on the presence of an entry: a retry that
  // succeeded leaves the earlier failure's entry on the row forever.
  const publishFailure =
    publishTarget?.status === "failed"
      ? (lastPublishError(post.execution_logs) ??
        "The run recorded no reason. The worker log has the detail.")
      : null;
  // The stage the header's re-run will start from, derived the way the handler
  // derives it so the button cannot promise a stage the run does not begin at.
  const resumeFrom = resumeStage(post.stage_status);
  // A post nothing has ever executed against: no stage has moved off
  // `pending` and no stage column holds output. Posts normally start on
  // creation, so this is the state of a post whose run never reached the
  // worker, which is exactly when an operator needs a way to start one.
  const neverRan =
    STAGES.every((s) => {
      const status = post.stage_status[s];
      return !status || status === "pending";
    }) && STAGES.every((s) => !post[STAGE_CONTENT_FIELDS[s]]);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon" className="mt-1">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {post.topic}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs font-mono text-muted-foreground">
                {post.slug}
              </span>
              <RunStateBadge
                currentStage={post.current_stage}
                stageStatus={post.stage_status}
              />
              {post.wp_publish_status === "published" && post.wp_post_url && (
                <a
                  href={post.wp_post_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1"
                >
                  <Badge variant="outline" className="text-green-600 border-green-600">
                    Published
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </Badge>
                </a>
              )}
              {post.wp_publish_status === "pending" && (
                <Badge variant="outline" className="text-amber-600 border-amber-600">
                  Queued to publish
                </Badge>
              )}
              {post.wp_publish_status === "publishing" && (
                <Badge variant="outline">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Publishing...
                </Badge>
              )}
              {post.wp_publish_status === "failed" && (
                <Badge variant="destructive">Publish failed</Badge>
              )}
              {post.nextjs_publish_status === "published" && (
                <Badge variant="outline" className="text-green-600 border-green-600">
                  Published to Next.js
                  {post.nextjs_published_at && (
                    <span className="ml-1 text-[10px] opacity-70">
                      {new Date(post.nextjs_published_at).toLocaleString()}
                    </span>
                  )}
                </Badge>
              )}
              {post.nextjs_publish_status === "pending" && (
                <Badge variant="outline" className="text-amber-600 border-amber-600">
                  Queued to publish
                </Badge>
              )}
              {post.nextjs_publish_status === "publishing" && (
                <Badge variant="outline">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Publishing to Next.js...
                </Badge>
              )}
              {post.nextjs_publish_status === "failed" && (
                <Badge variant="destructive">Publish failed</Badge>
              )}
              {saving && (
                <span className="text-xs text-muted-foreground animate-pulse">
                  Saving...
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isRunning && (
            <Button variant="outline" size="sm" onClick={handlePause}>
              <Pause className="h-3.5 w-3.5 mr-1.5" />
              Pause
            </Button>
          )}
          {neverRan ? (
            <Button size="sm" onClick={handleRun}>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Run Pipeline
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleRerun}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Resume from {STAGE_LABELS[resumeFrom]}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmingRestart(true)}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Start Over
              </Button>
            </>
          )}
          {post.output_format === "wordpress" &&
            isComplete &&
            (!post.wp_publish_status || post.wp_publish_status === "pending") && (
              <Button size="sm" onClick={handlePublish}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Publish to WordPress
              </Button>
            )}
          {post.output_format === "nextjs" &&
            isComplete &&
            (!post.nextjs_publish_status || post.nextjs_publish_status === "pending") && (
              <Button size="sm" onClick={handlePublish}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Publish to Next.js
              </Button>
            )}

          <ExportButton
            postId={postId}
            hasMd={!!(post.ready_content || post.final_md_content)}
            hasHtml={!!post.final_html_content}
            mdContent={post.ready_content || post.final_md_content}
            htmlContent={post.final_html_content}
            wpPostUrl={post.wp_post_url}
          />
        </div>
      </div>

      {/* A refetch that failed over a page that still has a post to show. */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">This post is out of date</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={retry}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      )}

      {/*
        A publish runs in the worker, so its reason arrives as one toast the
        user may not have been looking at. This is the same reason read back
        off the row, so it survives a reload for as long as the status column
        says the attempt failed.
      */}
      {publishTarget && publishFailure && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              Publishing to {publishTarget.label} failed
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{publishFailure}</p>
          </div>
          <Button variant="outline" size="sm" onClick={handlePublish}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Try publishing again
          </Button>
        </div>
      )}

      {/*
        The one thing on this page that is waiting on the reader rather than on
        a machine. It sits above the failure banners because a parked run is
        not broken, it is asking a question, and nothing else moves until it is
        answered. `runState.reviewStages` is the same derivation the badge in
        the header uses, so the two cannot disagree about whether a gate is
        open.
      */}
      {runState.reviewStages.map((stage) => (
        <div
          key={stage}
          className="flex items-start gap-3 rounded-md border border-sky-500/40 bg-sky-500/5 px-4 py-3"
        >
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {STAGE_LABELS[stage]} is waiting for your approval
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The run stopped in front of this stage and will not go on until
              you release it. Everything it has written so far is in the tabs
              below.
            </p>
          </div>
          <Button size="sm" onClick={() => handleApprove(stage)}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
            Approve and continue
          </Button>
        </div>
      ))}

      {/*
        A stage can fail without stopping the run: the `images` stage writes
        `images: failed` and returns rather than raising, and the chain carries
        on to `ready` and stamps the post complete. Without this the only trace
        of it on screen was a red dot in the progress bar. One row per failed
        stage, each with what it reported and the one retry the API has for it.
      */}
      {stageFailures.map(({ stage, reason }) => (
        <div
          key={stage}
          role="alert"
          className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{STAGE_LABELS[stage]} failed</p>
            <p className="mt-0.5 text-sm text-muted-foreground break-words">{reason}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => handleRetryStage(stage)}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Re-run {STAGE_LABELS[stage]}
          </Button>
        </div>
      ))}

      {/* Pipeline Progress */}
      <Card className="gap-0 py-0">
        <CardContent className="py-4">
          <div className="flex items-center justify-center">
            <PipelineProgress
              stageStatus={post.stage_status}
              currentStage={post.current_stage}
            />
          </div>
        </CardContent>
      </Card>

      {/* Run Trace */}
      <RunTrace
        executionLogs={post.execution_logs}
        stageStatus={post.stage_status}
        liveStart={liveStart}
        liveImages={liveImages}
        publish={
          publishTarget
            ? { target: publishTarget.target, status: publishTarget.status ?? "pending" }
            : null
        }
        onApprove={handleApprove}
      />

      {/* Stage Content Tabs */}
      {neverRan ? (
        <Card className="py-0">
          <CardContent className="py-16 text-center">
            <p className="text-base font-medium">This post has not run yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Stage output appears here as the pipeline writes it. Start the run
              to fill Research, Outline, Write, Edit, Images and Ready.
            </p>
            <Button size="sm" className="mt-4" onClick={handleRun}>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Run Pipeline
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex items-center justify-between">
            <TabsList>
              {STAGES.map((stage) => {
                const hasContent = !!post[STAGE_CONTENT_FIELDS[stage]];
                return (
                  <TabsTrigger
                    key={stage}
                    value={stage}
                    className="relative"
                    disabled={!hasContent}
                  >
                    {STAGE_LABELS[stage]}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="flex items-center gap-2">
              {activeTab &&
                activeTab !== "images" &&
                activeTab !== "ready" &&
                post[STAGE_CONTENT_FIELDS[activeTab as PipelineStage]] && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      copyContent(
                        String(
                          post[STAGE_CONTENT_FIELDS[activeTab as PipelineStage]]
                        )
                      )
                    }
                    className="text-xs"
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                  </Button>
                )}
            </div>
          </div>

          {STAGES.map((stage) => {
            const field = STAGE_CONTENT_FIELDS[stage];
            const content = post[field];

            return (
              <TabsContent key={stage} value={stage} className="mt-4">
                {stage === "ready" ? (
                  content ? (
                    <Card className="gap-0 py-0">
                      <CardHeader className="flex flex-row items-center justify-between py-3">
                        <CardTitle className="text-base">Ready — Live Preview</CardTitle>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyContent(content as string)}
                          className="text-xs"
                        >
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </Button>
                      </CardHeader>
                      <Separator />
                      <CardContent className="p-0">
                        <ContentPreview
                          content={content as string}
                          height="800px"
                        />
                      </CardContent>
                    </Card>
                  ) : (
                    <Card className="py-0">
                      <CardContent className="py-12 text-center">
                        <p className="text-muted-foreground text-sm">
                          {post.stage_status[stage] === "running"
                            ? "Running Ready..."
                            : "No ready content yet"}
                        </p>
                      </CardContent>
                    </Card>
                  )
                ) : stage === "images" ? (
                  <ImagePreview
                    manifest={content as Record<string, unknown> | null}
                    onRetry={handleRetryImages}
                  />
                ) : content ? (
                  <Card className="gap-0 py-0">
                    <CardHeader className="flex flex-row items-center justify-between py-3">
                      <CardTitle className="text-base">
                        {STAGE_LABELS[stage]} Output
                      </CardTitle>
                    </CardHeader>
                    <Separator />
                    <CardContent className="p-0">
                      <MarkdownEditor
                        content={editorContent}
                        onChange={setEditorContent}
                        onSave={handleSave}
                        height="500px"
                        readOnly={
                          post.stage_status[stage] === "running"
                        }
                      />
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="py-0">
                    <CardContent className="py-12 text-center">
                      <p className="text-muted-foreground text-sm">
                        {post.stage_status[stage] === "running"
                          ? `Running ${STAGE_LABELS[stage]}...`
                          : `No ${STAGE_LABELS[stage].toLowerCase()} content yet`}
                      </p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}

      {/* Debug Logs */}
      <DebugLogPanel logs={debugLogs} isRunning={isRunning} />

      {/* Analytics. The endpoint answers zeroes for a post with no content, so
          nothing here is conditional on the pipeline having run: a card with no
          numbers in it is the honest empty state, and a failure is the server's
          own message rather than the silence it used to be. */}
      {analytics ? (
        <Card className="gap-0 py-0">
          <CardHeader className="py-3">
            <CardTitle className="text-base">Analytics</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-4 py-4">
            <AnalyticsBar
              analytics={analytics}
              targetWordCount={post.word_count}
            />
            <SeoChecklist checklist={analytics.seo_checklist} />
            <KeywordDensity density={analytics.keyword_density} />
          </CardContent>
        </Card>
      ) : (
        analyticsError && (
          <Card className="gap-0 py-0">
            <CardHeader className="py-3">
              <CardTitle className="text-base">Analytics</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="py-6 text-center">
              <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
              <p className="mt-2 text-sm font-medium">Analytics unavailable</p>
              <p className="mt-1 text-sm text-muted-foreground">{analyticsError}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={fetchAnalytics}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
            </CardContent>
          </Card>
        )
      )}

      {/*
        The one destructive run control. Everything it clears is regenerable,
        which is why it is a confirmation rather than a typed name, but it is
        regenerable only by paying for six more model calls, so the sentence
        names the output and the cost record it throws away and the settings it
        keeps.
      */}
      <AlertDialog open={confirmingRestart} onOpenChange={setConfirmingRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start this post over?</AlertDialogTitle>
            <AlertDialogDescription>
              The run begins again at Research. Everything the pipeline has
              produced for this post is discarded first: the research notes, the
              outline, the draft, the edited copy, the images and the final
              article, along with this run&apos;s token and cost record. The
              post&apos;s own settings and review gates are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep this run</AlertDialogCancel>
            {/*
              `variant`, not a `className` override: `AlertDialogAction` renders
              a `Button` and puts the child's class *inside* it, so a
              `bg-destructive` class loses to the button's own `variant` classes
              in the cascade. The two delete dialogs on `/` do it the other way
              and are not actually red; filed in `todo.md`.
            */}
            <AlertDialogAction variant="destructive" onClick={handleRestart}>
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
