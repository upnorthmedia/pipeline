"use client";

import { useEffect, useState } from "react";
import {
  Save,
  Settings,
  FileText,
  Loader2,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  AlertCircle,
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
import { Badge } from "@/components/ui/badge";
import {
  apiKeys,
  rules,
  type ApiKeyStatus,
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

const PROVIDERS = [
  { key: "anthropic" as const, label: "Anthropic", prefix: "sk-ant-" },
  { key: "perplexity" as const, label: "Perplexity", prefix: "pplx-" },
  { key: "gemini" as const, label: "Gemini", prefix: "AIza" },
] as const;

type ProviderKey = (typeof PROVIDERS)[number]["key"];

export default function SettingsPage() {
  // API keys state
  const [keyValues, setKeyValues] = useState<Record<ProviderKey, string>>({
    anthropic: "",
    perplexity: "",
    gemini: "",
  });
  const [keyStatuses, setKeyStatuses] = useState<Record<string, ApiKeyStatus>>({});
  const [keyVisible, setKeyVisible] = useState<Record<ProviderKey, boolean>>({
    anthropic: false,
    perplexity: false,
    gemini: false,
  });
  const [revealedKeys, setRevealedKeys] = useState<Record<ProviderKey, string>>({
    anthropic: "",
    perplexity: "",
    gemini: "",
  });
  const [revealingKey, setRevealingKey] = useState<Record<ProviderKey, boolean>>({
    anthropic: false,
    perplexity: false,
    gemini: false,
  });
  const [keyErrors, setKeyErrors] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(true);

  // Rule files state
  const [ruleFiles, setRuleFiles] = useState<RuleFile[]>([]);
  const [activeRule, setActiveRule] = useState<string>(RULE_NAMES[0]);
  const [ruleContent, setRuleContent] = useState("");
  const [loadingRule, setLoadingRule] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [loadingRuleList, setLoadingRuleList] = useState(true);

  // Load API key statuses on mount
  useEffect(() => {
    apiKeys
      .get()
      .then(setKeyStatuses)
      .catch(() => toast.error("Failed to load API key status"))
      .finally(() => setLoadingKeys(false));
  }, []);

  // Load rule file list on mount
  useEffect(() => {
    rules
      .list()
      .then(setRuleFiles)
      .catch(() => toast.error("Failed to load rule files"))
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

  const validateFormat = (provider: ProviderKey, value: string) => {
    if (!value) {
      setKeyErrors((prev) => ({ ...prev, [provider]: "" }));
      return;
    }
    const config = PROVIDERS.find((p) => p.key === provider);
    if (config && !value.startsWith(config.prefix)) {
      setKeyErrors((prev) => ({
        ...prev,
        [provider]: `Expected prefix: ${config.prefix}`,
      }));
    } else {
      setKeyErrors((prev) => ({ ...prev, [provider]: "" }));
    }
  };

  const handleToggleReveal = async (provider: ProviderKey) => {
    if (keyVisible[provider]) {
      // Hide: clear revealed key
      setKeyVisible((prev) => ({ ...prev, [provider]: false }));
      setRevealedKeys((prev) => ({ ...prev, [provider]: "" }));
      return;
    }

    // Show: fetch decrypted key from backend
    setRevealingKey((prev) => ({ ...prev, [provider]: true }));
    try {
      const { key } = await apiKeys.reveal(provider);
      setRevealedKeys((prev) => ({ ...prev, [provider]: key }));
      setKeyVisible((prev) => ({ ...prev, [provider]: true }));
    } catch {
      toast.error(`Failed to reveal ${provider} key`);
    } finally {
      setRevealingKey((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const handleSaveKeys = async () => {
    setSavingKeys(true);
    try {
      const payload: Record<string, string> = {};
      for (const p of PROVIDERS) {
        if (keyValues[p.key]) {
          payload[p.key] = keyValues[p.key];
        }
      }
      const result = await apiKeys.update(payload);
      setKeyStatuses(result);
      // Clear typed values and any revealed keys
      setKeyValues({ anthropic: "", perplexity: "", gemini: "" });
      setRevealedKeys({ anthropic: "", perplexity: "", gemini: "" });
      setKeyVisible({ anthropic: false, perplexity: false, gemini: false });

      const allValid = Object.values(result).every(
        (s) => s.valid === null || s.valid === true
      );
      if (allValid) {
        toast.success("API keys saved and validated");
      } else {
        toast.error("Some keys failed validation — check status badges");
      }
    } catch {
      toast.error("Failed to save API keys");
    } finally {
      setSavingKeys(false);
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

  const hasKeyChanges = PROVIDERS.some((p) => keyValues[p.key].length > 0);
  const hasFormatErrors = Object.values(keyErrors).some((e) => e);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Settings className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            API keys and rule file editor
          </p>
        </div>
      </div>

      {/* API Keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="h-4 w-4" />
            API Keys
          </CardTitle>
          <CardDescription>
            Configure LLM provider API keys (encrypted at rest)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingKeys ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <div className="flex gap-2">
                    <Skeleton className="h-10 flex-1" />
                    <Skeleton className="h-10 w-10" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {PROVIDERS.map((provider) => {
                const status = keyStatuses[provider.key];
                return (
                  <div key={provider.key} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`key-${provider.key}`}>
                        {provider.label}
                      </Label>
                      {status && (
                        <StatusBadge status={status} />
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id={`key-${provider.key}`}
                        type={
                          keyVisible[provider.key] && !keyValues[provider.key]
                            ? "text"
                            : keyValues[provider.key]
                              ? "password"
                              : "text"
                        }
                        placeholder={
                          status?.configured
                            ? `Configured (${status.hint})`
                            : `Enter ${provider.label} API key`
                        }
                        value={
                          keyValues[provider.key] ||
                          (keyVisible[provider.key]
                            ? revealedKeys[provider.key]
                            : "")
                        }
                        onChange={(e) => {
                          // If user starts typing, clear revealed state
                          if (revealedKeys[provider.key]) {
                            setRevealedKeys((prev) => ({
                              ...prev,
                              [provider.key]: "",
                            }));
                            setKeyVisible((prev) => ({
                              ...prev,
                              [provider.key]: false,
                            }));
                          }
                          setKeyValues((prev) => ({
                            ...prev,
                            [provider.key]: e.target.value,
                          }));
                        }}
                        onBlur={() =>
                          validateFormat(provider.key, keyValues[provider.key])
                        }
                        readOnly={
                          keyVisible[provider.key] &&
                          !!revealedKeys[provider.key] &&
                          !keyValues[provider.key]
                        }
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        type="button"
                        disabled={
                          revealingKey[provider.key] ||
                          (!status?.configured && !keyValues[provider.key])
                        }
                        onClick={() => handleToggleReveal(provider.key)}
                        aria-label={`Toggle ${provider.label} key visibility`}
                      >
                        {revealingKey[provider.key] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : keyVisible[provider.key] ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    {keyErrors[provider.key] && (
                      <p className="text-xs text-destructive">
                        {keyErrors[provider.key]}
                      </p>
                    )}
                  </div>
                );
              })}

              <Separator />
              <div className="flex justify-end">
                <Button
                  onClick={handleSaveKeys}
                  disabled={savingKeys || !hasKeyChanges || hasFormatErrors}
                >
                  {savingKeys ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save &amp; Validate
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

function StatusBadge({ status }: { status: ApiKeyStatus }) {
  if (!status.configured) {
    return (
      <Badge variant="outline" className="text-muted-foreground gap-1">
        <AlertCircle className="h-3 w-3" />
        Not configured
      </Badge>
    );
  }
  if (status.valid === true) {
    return (
      <Badge variant="outline" className="text-green-600 border-green-200 gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Valid
      </Badge>
    );
  }
  if (status.valid === false) {
    return (
      <Badge variant="outline" className="text-destructive border-destructive/30 gap-1">
        <XCircle className="h-3 w-3" />
        Invalid
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      Configured
    </Badge>
  );
}
