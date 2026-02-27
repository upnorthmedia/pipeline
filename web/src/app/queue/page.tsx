"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { RefreshCw, Check, Eye, RotateCcw, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StageBadge } from "@/components/stage-badge";
import { PipelineProgress } from "@/components/pipeline-progress";
import { queue, posts, type Post, type PipelineStage } from "@/lib/api";
import { useSSE } from "@/hooks/use-sse";
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

function getReviewStage(post: Post): PipelineStage | null {
  for (const [stage, status] of Object.entries(post.stage_status)) {
    if (status === "review") return stage as PipelineStage;
  }
  return null;
}

function getReviewContent(post: Post): string | null {
  const stageContentMap: Record<string, string | null> = {
    research: post.research_content,
    outline: post.outline_content,
    write: post.draft_content,
    edit: post.final_md_content,
    images: null,
  };
  const stage = getReviewStage(post);
  if (!stage) return null;
  return stageContentMap[stage] ?? null;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "...";
}

export default function QueuePage() {
  const [reviewPosts, setReviewPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());

  const fetchReviewPosts = useCallback(async () => {
    try {
      const data = await queue.review();
      setReviewPosts(data);
    } catch {
      toast.error("Failed to load review queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReviewPosts();
  }, [fetchReviewPosts]);

  useSSE(undefined, (event) => {
    if (
      event.event === "review_needed" ||
      event.event === "stage_complete" ||
      event.event === "pipeline_complete"
    ) {
      fetchReviewPosts();
    }
  });

  const setActionBusy = (id: string, busy: boolean) => {
    setActionLoading((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleApprove = async (post: Post) => {
    setActionBusy(post.id, true);
    try {
      await posts.approve(post.id);
      toast.success(`Approved "${post.topic}"`);
      fetchReviewPosts();
    } catch {
      toast.error("Failed to approve post");
    } finally {
      setActionBusy(post.id, false);
    }
  };

  const handleRerun = async (post: Post) => {
    const stage = getReviewStage(post);
    if (!stage) return;
    setActionBusy(post.id, true);
    try {
      await posts.rerun(post.id, stage);
      toast.success(`Re-running ${stage} for "${post.topic}"`);
      fetchReviewPosts();
    } catch {
      toast.error("Failed to re-run stage");
    } finally {
      setActionBusy(post.id, false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Review Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {loading
              ? "Loading..."
              : `${reviewPosts.length} post${reviewPosts.length !== 1 ? "s" : ""} awaiting review`}
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={fetchReviewPosts}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/2 mt-1" />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-2 w-24" />
                </div>
                <Skeleton className="h-16 w-full" />
              </CardContent>
              <CardFooter>
                <div className="flex gap-2">
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-18" />
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && reviewPosts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
            <Inbox className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">No posts awaiting review</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Posts that reach a review gate will appear here. Configure stage
            settings to &quot;review&quot; mode to enable review gates.
          </p>
        </div>
      )}

      {/* Review cards grid */}
      {!loading && reviewPosts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {reviewPosts.map((post) => {
            const reviewStage = getReviewStage(post);
            const content = getReviewContent(post);
            const isBusy = actionLoading.has(post.id);

            return (
              <Card key={post.id} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="text-sm leading-snug line-clamp-2">
                    {post.topic}
                  </CardTitle>
                  <p className="text-[11px] font-mono text-muted-foreground">
                    {post.slug}
                  </p>
                </CardHeader>

                <CardContent className="flex-1 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StageBadge stage={post.current_stage} />
                      <PipelineProgress
                        stageStatus={post.stage_status}
                        currentStage={post.current_stage}
                        compact
                      />
                    </div>
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                      {timeAgo(post.updated_at)}
                    </span>
                  </div>

                  {content && (
                    <div className="rounded-md border border-border bg-muted/50 p-3">
                      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                        {truncate(content, 200)}
                      </p>
                    </div>
                  )}
                </CardContent>

                <CardFooter className="gap-2 flex-wrap">
                  <Button
                    size="sm"
                    onClick={() => handleApprove(post)}
                    disabled={isBusy}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <Check className="h-3.5 w-3.5 mr-1.5" />
                    Approve
                  </Button>
                  <Link href={`/posts/${post.id}`}>
                    <Button size="sm" variant="outline">
                      <Eye className="h-3.5 w-3.5 mr-1.5" />
                      View & Edit
                    </Button>
                  </Link>
                  {reviewStage && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRerun(post)}
                      disabled={isBusy}
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                      Re-run
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
