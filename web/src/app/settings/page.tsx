"use client";

import { useEffect, useState } from "react";
import {
  Save,
  Settings,
  FileText,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  settings,
  rules,
  type Setting,
  type RuleFile,
} from "@/lib/api";
import { toast } from "sonner";

const RULE_NAMES = [
  "blog-research",
  "blog-outline",
  "blog-write",
  "blog-edit",
  "blog-images",
  "blog-ready",
] as const;

export default function SettingsPage() {
  // Worker config state
  const [maxJobs, setMaxJobs] = useState(3);
  const [savingWorker, setSavingWorker] = useState(false);

  // Rule files state
  const [ruleFiles, setRuleFiles] = useState<RuleFile[]>([]);
  const [activeRule, setActiveRule] = useState<string>(RULE_NAMES[0]);
  const [ruleContent, setRuleContent] = useState("");
  const [loadingRule, setLoadingRule] = useState(false);
  const [savingRule, setSavingRule] = useState(false);

  // Loading state
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadingRuleList, setLoadingRuleList] = useState(true);

  // Load settings on mount
  useEffect(() => {
    settings
      .list()
      .then((list: Setting[]) => {
        const workerSetting = list.find((s) => s.key === "worker_max_jobs");
        if (workerSetting?.value?.max_jobs) {
          setMaxJobs(workerSetting.value.max_jobs as number);
        }
      })
      .catch(() => {
        toast.error("Failed to load settings");
      })
      .finally(() => setLoadingSettings(false));
  }, []);

  // Load rule file list on mount
  useEffect(() => {
    rules
      .list()
      .then(setRuleFiles)
      .catch(() => {
        toast.error("Failed to load rule files");
      })
      .finally(() => setLoadingRuleList(false));
  }, []);

  // Load rule content when active rule changes
  useEffect(() => {
    setLoadingRule(true);
    rules
      .get(activeRule)
      .then((rc) => setRuleContent(rc.content))
      .catch(() => {
        setRuleContent("");
        toast.error(`Failed to load ${activeRule}`);
      })
      .finally(() => setLoadingRule(false));
  }, [activeRule]);

  const handleSaveWorker = async () => {
    setSavingWorker(true);
    try {
      await settings.update({
        worker_max_jobs: { value: { max_jobs: maxJobs } },
      });
      toast.success("Worker configuration saved");
    } catch {
      toast.error("Failed to save worker configuration");
    } finally {
      setSavingWorker(false);
    }
  };

  const handleSaveRule = async () => {
    setSavingRule(true);
    try {
      await rules.update(activeRule, ruleContent);
      toast.success(`Rule file "${activeRule}" saved`);
    } catch {
      toast.error(`Failed to save ${activeRule}`);
    } finally {
      setSavingRule(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Settings className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Worker configuration and rule file editor
          </p>
        </div>
      </div>

      {/* Worker Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Worker Configuration
          </CardTitle>
          <CardDescription>
            Configure the background worker settings
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingSettings ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-40" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="maxJobs">Worker Concurrency</Label>
                <Input
                  id="maxJobs"
                  type="number"
                  min={1}
                  max={10}
                  value={maxJobs}
                  onChange={(e) => setMaxJobs(Number(e.target.value))}
                  className="w-40"
                />
                <p className="text-[11px] text-muted-foreground">
                  Maximum number of concurrent pipeline jobs (1-10)
                </p>
              </div>
              <Separator />
              <div className="flex justify-end">
                <Button onClick={handleSaveWorker} disabled={savingWorker}>
                  {savingWorker ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Rule File Editor */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Rule Files
          </CardTitle>
          <CardDescription>
            Edit pipeline rule files that control each stage
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingRuleList ? (
            <div className="space-y-4">
              <div className="flex gap-2">
                {RULE_NAMES.map((name) => (
                  <Skeleton key={name} className="h-9 w-28" />
                ))}
              </div>
              <Skeleton className="h-[400px] w-full" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {RULE_NAMES.map((name) => {
                  const file = ruleFiles.find((r) => r.name === name);
                  return (
                    <Button
                      key={name}
                      variant={activeRule === name ? "default" : "outline"}
                      size="sm"
                      onClick={() => setActiveRule(name)}
                    >
                      {name}
                      {file && !file.exists && (
                        <span className="ml-1 text-[10px] opacity-60">
                          (new)
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>

              {loadingRule ? (
                <Skeleton className="h-[400px] w-full" />
              ) : (
                <Textarea
                  value={ruleContent}
                  onChange={(e) => setRuleContent(e.target.value)}
                  className="font-mono text-sm min-h-[400px] resize-y"
                  placeholder={`Enter content for ${activeRule}...`}
                />
              )}

              <Separator />
              <div className="flex justify-end">
                <Button
                  onClick={handleSaveRule}
                  disabled={savingRule || loadingRule}
                >
                  {savingRule ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save {activeRule}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
