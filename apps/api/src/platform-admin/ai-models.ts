/**
 * SA-1035: THE list of Claude models the app offers and THE map of what each AI task runs on. No model id is written
 * anywhere else in app code (pinned by `ai-models.spec.ts`), so a new generation is an edit to this file only.
 */

export type AiModelFamily = "fable" | "opus" | "sonnet" | "haiku";

export interface AiModel {
  id: string;
  label: string;
  family: AiModelFamily;
}

/** The models the pickers offer: the latest generation, all four families (the owner's "all the latest models"). */
export const AI_MODELS: readonly AiModel[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", family: "fable" },
  { id: "claude-opus-5-5", label: "Opus 5.5", family: "opus" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", family: "sonnet" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", family: "haiku" },
];

/** Every job that calls a Claude model. A new task must name its setting key and fallback here to compile. */
export type AiTask = "general" | "bill_scan" | "receipt_scan" | "statement_scan";

export interface AiTaskDef {
  /** The PlatformConfig row the super admin sets, or null when the task has no picker. */
  key: string | null;
  /** Used while the row is unset. */
  fallback: string;
}

export const AI_TASKS: Record<AiTask, AiTaskDef> = {
  general: { key: "claude.model", fallback: "claude-sonnet-5-5" },
  bill_scan: { key: "claude.scanModel", fallback: "claude-haiku-5-5" },
  receipt_scan: { key: null, fallback: "claude-opus-5-5" },
  // Supplier statements keep the model they were already scanning with (no picker; moving it is its own decision).
  statement_scan: { key: null, fallback: "claude-sonnet-5" },
};

export function isAiModelId(id: unknown): id is string {
  return typeof id === "string" && AI_MODELS.some((m) => m.id === id);
}

/** The family a model id prices as: from the list, else by the name inside an older id (as before). */
export function aiModelFamily(id: string): AiModelFamily {
  const listed = AI_MODELS.find((m) => m.id === id);
  if (listed) return listed.family;
  const name = id.toLowerCase();
  if (name.includes("fable")) return "fable";
  if (name.includes("opus")) return "opus";
  if (name.includes("haiku")) return "haiku";
  return "sonnet";
}
