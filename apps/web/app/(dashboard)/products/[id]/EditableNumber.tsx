import { DecimalInput } from "@/components/MoneyInput";

// ─── Inline number field ──────────────────────────────────────────────────────
// Thin wrapper over DecimalInput so price/tier fields never reformat while
// typing (the old numeric-bound input ate decimal points mid-keystroke).

export function EditableNumber({
  value,
  onChange,
  onCommit,
  auto,
}: {
  value: number;
  /** An Auto (0) tier: an empty box that reads "Auto". */
  auto?: boolean;
  onChange: (v: number) => void;
  onCommit?: (v: number, valueAtFocus: number | null) => void;
}) {
  return (
    <DecimalInput
      min={0}
      value={!auto && Number.isFinite(value) ? value : null}
      placeholder={auto ? "Auto" : undefined}
      onChange={(v) => onChange(v ?? 0)}
      onCommit={onCommit}
      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
    />
  );
}
