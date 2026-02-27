"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Upload,
  Plus,
  Trash2,
  FileSpreadsheet,
  List,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  posts,
  profiles,
  type Profile,
  type PostCreate,
} from "@/lib/api";
import { toast } from "sonner";

const INTENTS = ["informational", "commercial", "transactional", "navigational"];
const MAX_ROWS = 20;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseCSV(
  text: string
): Array<{ topic: string; slug?: string; intent?: string; niche?: string }> {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines
    .slice(1)
    .map((line) => {
      const values = line.split(",").map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = values[i] || "";
      });
      return row as { topic: string; slug?: string; intent?: string; niche?: string };
    })
    .filter((row) => row.topic);
}

interface BatchRow {
  topic: string;
  slug: string;
  intent: string;
  niche: string;
}

function emptyRow(): BatchRow {
  return { topic: "", slug: "", intent: "", niche: "" };
}

export default function BatchCreatePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profileList, setProfileList] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // CSV mode
  const [csvRows, setCsvRows] = useState<BatchRow[]>([]);
  const [csvFilename, setCsvFilename] = useState<string | null>(null);

  // Manual mode
  const [manualRows, setManualRows] = useState<BatchRow[]>([emptyRow()]);

  // Active tab
  const [activeTab, setActiveTab] = useState("csv");

  useEffect(() => {
    profiles.list().then(setProfileList).catch(() => {});
  }, []);

  const handleProfileChange = (profileId: string) => {
    if (profileId === "none") {
      setSelectedProfile(null);
    } else {
      const profile = profileList.find((p) => p.id === profileId) || null;
      setSelectedProfile(profile);
    }
  };

  // CSV handling
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      try {
        const parsed = parseCSV(text);
        if (parsed.length === 0) {
          toast.error("No valid rows found in CSV");
          return;
        }
        const rows: BatchRow[] = parsed.map((r) => ({
          topic: r.topic,
          slug: r.slug || slugify(r.topic),
          intent: r.intent || "",
          niche: r.niche || "",
        }));
        setCsvRows(rows);
        setCsvFilename(file.name);
      } catch {
        toast.error("Failed to parse CSV file");
      }
    };
    reader.readAsText(file);
  };

  const clearCsv = () => {
    setCsvRows([]);
    setCsvFilename(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Manual handling
  const addManualRow = () => {
    if (manualRows.length >= MAX_ROWS) {
      toast.error(`Maximum ${MAX_ROWS} rows allowed`);
      return;
    }
    setManualRows((prev) => [...prev, emptyRow()]);
  };

  const removeManualRow = (index: number) => {
    setManualRows((prev) => prev.filter((_, i) => i !== index));
  };

  const updateManualRow = (index: number, field: keyof BatchRow, value: string) => {
    setManualRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const updated = { ...row, [field]: value };
        if (field === "topic" && row.slug === slugify(row.topic)) {
          updated.slug = slugify(value);
        }
        return updated;
      })
    );
  };

  // Get active rows
  const activeRows = activeTab === "csv" ? csvRows : manualRows.filter((r) => r.topic.trim());

  // Submit
  const handleSubmit = async () => {
    if (activeRows.length === 0) {
      toast.error("No posts to create");
      return;
    }

    const seen = new Set<string>();
    for (const row of activeRows) {
      if (!row.topic.trim()) {
        toast.error("All rows must have a topic");
        return;
      }
      const s = row.slug || slugify(row.topic);
      if (seen.has(s)) {
        toast.error(`Duplicate slug: ${s}`);
        return;
      }
      seen.add(s);
    }

    setSubmitting(true);
    try {
      const items: PostCreate[] = activeRows.map((row) => ({
        slug: row.slug || slugify(row.topic),
        topic: row.topic.trim(),
        profile_id: selectedProfile?.id || undefined,
        intent: row.intent || undefined,
        niche: row.niche || selectedProfile?.niche || undefined,
        target_audience: selectedProfile?.target_audience || undefined,
        tone: selectedProfile?.tone || "Conversational and friendly",
        word_count: selectedProfile?.word_count || 2000,
        output_format: selectedProfile?.output_format || "both",
        website_url: selectedProfile?.website_url || undefined,
        brand_voice: selectedProfile?.brand_voice || undefined,
        avoid: selectedProfile?.avoid || undefined,
        related_keywords: selectedProfile?.related_keywords || [],
        stage_settings: selectedProfile?.default_stage_settings,
      }));

      const created = await posts.batchCreate(items);
      toast.success(`Created ${created.length} posts`);
      router.push("/");
    } catch {
      toast.error("Failed to create posts");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Batch Create Posts</h1>
          <p className="text-sm text-muted-foreground">
            Create multiple posts at once from CSV or manual entry
          </p>
        </div>
      </div>

      {/* Profile selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Website Profile</CardTitle>
          <CardDescription>
            Apply profile defaults to all batch items
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={selectedProfile?.id || "none"}
            onValueChange={handleProfileChange}
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

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="csv">
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            CSV Upload
          </TabsTrigger>
          <TabsTrigger value="manual">
            <List className="h-4 w-4 mr-2" />
            Manual Entry
          </TabsTrigger>
        </TabsList>

        {/* CSV Upload */}
        <TabsContent value="csv" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upload CSV</CardTitle>
              <CardDescription>
                CSV must have a &quot;topic&quot; column. Optional columns: slug, intent, niche.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  className="max-w-sm"
                />
                {csvRows.length > 0 && (
                  <Button variant="outline" size="sm" onClick={clearCsv}>
                    Clear
                  </Button>
                )}
              </div>
              {csvFilename && (
                <p className="text-sm text-muted-foreground">
                  Loaded {csvRows.length} rows from {csvFilename}
                </p>
              )}
            </CardContent>
          </Card>

          {csvRows.length > 0 && (
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Topic</TableHead>
                    <TableHead className="w-[180px]">Slug</TableHead>
                    <TableHead className="w-[140px]">Intent</TableHead>
                    <TableHead className="w-[160px]">Niche</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {csvRows.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground text-xs">
                        {i + 1}
                      </TableCell>
                      <TableCell className="text-sm">{row.topic}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.slug}
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {row.intent || "-"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.niche || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Manual Entry */}
        <TabsContent value="manual" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manual Entry</CardTitle>
              <CardDescription>
                Add up to {MAX_ROWS} posts manually. Slugs are auto-generated from topics.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {manualRows.map((row, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground mt-3 w-6 text-right shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <Input
                      placeholder="Topic"
                      value={row.topic}
                      onChange={(e) => updateManualRow(i, "topic", e.target.value)}
                    />
                  </div>
                  <div className="w-[160px] shrink-0">
                    <Input
                      placeholder="slug"
                      value={row.slug}
                      onChange={(e) => updateManualRow(i, "slug", e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="w-[140px] shrink-0">
                    <Select
                      value={row.intent || "none"}
                      onValueChange={(v) =>
                        updateManualRow(i, "intent", v === "none" ? "" : v)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Intent" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No intent</SelectItem>
                        {INTENTS.map((intent) => (
                          <SelectItem key={intent} value={intent}>
                            <span className="capitalize">{intent}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeManualRow(i)}
                    disabled={manualRows.length <= 1}
                    className="shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={addManualRow}
                disabled={manualRows.length >= MAX_ROWS}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Row
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Separator />

      {/* Submit */}
      <div className="flex justify-end gap-3">
        <Link href="/">
          <Button variant="outline" type="button">
            Cancel
          </Button>
        </Link>
        <Button
          onClick={handleSubmit}
          disabled={submitting || activeRows.length === 0}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Upload className="h-4 w-4 mr-2" />
              Create {activeRows.length} Post{activeRows.length !== 1 ? "s" : ""}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
