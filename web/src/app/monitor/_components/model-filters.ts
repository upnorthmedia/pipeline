/**
 * The model picker both analytics tabs filter by.
 *
 * Named per model rather than per provider: ledger item 6.1 moved Anthropic and
 * Gemini onto new models and P2.71b moved `research` off `sonar-pro`, so runs
 * recorded before and after each change sit in the same table and every id has
 * to stay selectable. A row leaves this list only when nothing in `stage_logs`
 * can still carry it.
 *
 * One list rather than a copy per tab: the two were identical and had to agree,
 * which is the same drift P2.84 removed from the stage labels.
 */
export const MODEL_FILTERS = [
  { label: "All Models", value: "" },
  { label: "Perplexity Sonar", value: "perplexity/sonar" },
  { label: "Perplexity sonar-pro", value: "sonar-pro" },
  { label: "Claude Opus 5", value: "claude-opus-5" },
  { label: "Claude Opus 4.6", value: "claude-opus-4-6" },
  { label: "Gemini 3 Pro Image", value: "gemini-3-pro-image" },
  { label: "Gemini 3.1 Flash Image", value: "gemini-3.1-flash-image-preview" },
] as const;
