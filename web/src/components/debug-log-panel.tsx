"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Bug, AlertTriangle, XCircle, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface DebugLog {
  event: string;
  stage?: string;
  message?: string;
  level?: string;
  timestamp?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  duration_s?: number;
  error?: string;
}

interface DebugLogPanelProps {
  logs: DebugLog[];
  isRunning: boolean;
}

const LEVEL_CONFIG: Record<string, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: "text-muted-foreground" },
  warn: { icon: AlertTriangle, className: "text-yellow-500" },
  error: { icon: XCircle, className: "text-red-500" },
};

function formatTime(timestamp?: string): string {
  if (!timestamp) return "";
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function logMessage(log: DebugLog): string {
  if (log.message) return log.message;
  if (log.event === "stage_complete") {
    const parts = [`Stage complete`];
    if (log.model) parts.push(`(${log.model})`);
    if (log.tokens_out) parts.push(`${log.tokens_out} tokens`);
    if (log.duration_s) parts.push(`${log.duration_s}s`);
    return parts.join(" ");
  }
  if (log.event === "stage_error") return log.error || "Stage failed";
  if (log.event === "pipeline_complete") return "Pipeline finished";
  return log.event;
}

function logLevel(log: DebugLog): string {
  if (log.level) return log.level;
  if (log.event === "stage_error") return "error";
  return "info";
}

export function DebugLogPanel({ logs, isRunning }: DebugLogPanelProps) {
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  if (logs.length === 0 && !isRunning) return null;

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="py-3">
          <CollapsibleTrigger className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <Bug className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Debug Logs</CardTitle>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {logs.length}
              </Badge>
              {isRunning && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
              )}
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-3">
            <div
              ref={scrollRef}
              className="max-h-64 overflow-y-auto rounded border border-border bg-muted/30 font-mono text-xs"
            >
              {logs.length === 0 ? (
                <div className="p-3 text-muted-foreground text-center">
                  Waiting for events...
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {logs.map((log, i) => {
                    const level = logLevel(log);
                    const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;
                    const Icon = config.icon;
                    return (
                      <div key={i} className="flex items-start gap-2 px-3 py-1.5">
                        <span className="text-muted-foreground/60 shrink-0 pt-px">
                          {formatTime(log.timestamp)}
                        </span>
                        {log.stage && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0 shrink-0 capitalize"
                          >
                            {log.stage}
                          </Badge>
                        )}
                        <Icon className={cn("h-3 w-3 shrink-0 mt-0.5", config.className)} />
                        <span className={cn("break-all", config.className)}>
                          {logMessage(log)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
