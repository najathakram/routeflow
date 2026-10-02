"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { useCreateFamily, checkCodeAvailable } from "@/lib/api/product-families";
import { API_ERROR_CODES } from "@routeflow/types";
import { getFamilyConflicts } from "@/lib/family-conflicts";
import { safeTextErrorCopy } from "@/lib/safe-text-error-copy";
import {
  blankRow,
  COPY_PRICE_NEEDS_PRICE_MSG,
  toCreateRequest,
  validateFamilyForm,
  type FamilyForm,
  type GridRow,
} from "@/lib/family-grid";
import { FamilyVariantsGrid, type CellMessage } from "./FamilyVariantsGrid";

const emptyForm = (): FamilyForm => ({
  name: "",
  category: "",
  description: "",
  pricePerUnit: "",
  standardCost: "",
  copyFamilyPrice: false,
  rows: [blankRow("r0")],
});

const FIELD_NOUN: Record<string, string> = { sku: "SKU", barcode: "barcode", unitSku: "unit code" };

/**
 * WS8: "New family" — the family's own fields plus a grid of variants, created in ONE all-or-nothing
 * call. Client rules mirror the API; a refused write marks EVERY conflicting cell at once.
 */
export function CreateFamilyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const create = useCreateFamily();
  const [form, setForm] = React.useState<FamilyForm>(emptyForm);
  const [showErrors, setShowErrors] = React.useState(false);
  /** Server conflicts and advisory availability notes, `row:field` -> message. Edited cells drop theirs. */
  const [serverCells, setServerCells] = React.useState<Record<string, CellMessage>>({});
  const [familyServerMessages, setFamilyServerMessages] = React.useState<string[]>([]);
  const [summary, setSummary] = React.useState<string | null>(null);
  // The server's coded refusals shown as FIELD errors in fixed copy (never the raw message, never the generic toast).
  const [priceServerMessage, setPriceServerMessage] = React.useState<string | null>(null);

  const validation = React.useMemo(() => validateFamilyForm(form), [form]);
  // Latest rows, for async results that arrive after the grid changed under them.
  const rowsRef = React.useRef(form.rows);
  rowsRef.current = form.rows;

  const cellMessages: Record<string, CellMessage> = { ...serverCells };
  if (showErrors) {
    for (const [i, fields] of Object.entries(validation.rows)) {
      for (const [field, message] of Object.entries(fields ?? {})) {
        cellMessages[`${i}:${field}`] = { message: message as string };
      }
    }
  }

  const setRows = (rows: GridRow[]) => {
    // A cell the operator changed no longer carries its server message.
    setServerCells((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(prev)) {
        const [i, field] = key.split(":");
        const before = form.rows[Number(i)];
        const after = rows[Number(i)];
        if (!before || !after || before[field as keyof GridRow] !== after[field as keyof GridRow])
          delete next[key];
      }
      return next;
    });
    setForm((f) => ({ ...f, rows }));
  };

  const onCodeBlur = async (i: number, field: "sku" | "barcode" | "unitSku", value: string) => {
    const key = form.rows[i]?.key;
    const res = await checkCodeAvailable(value);
    if (!res || res.available || !key) return;
    // The answer is for THIS row and THIS value: if the row was removed (indexes shift) or the value
    // edited while the check was in flight, it no longer applies.
    const at = rowsRef.current.findIndex((r) => r.key === key);
    if (at < 0 || rowsRef.current[at][field].trim() !== value) return;
    setServerCells((prev) => ({
      ...prev,
      [`${at}:${field}`]: {
        message: `The ${FIELD_NOUN[field]} "${value}" is already used by another product.`,
        productId: res.takenBy?.productId,
      },
    }));
  };

  const submit = () => {
    setShowErrors(true);
    setSummary(null);
    setFamilyServerMessages([]);
    setPriceServerMessage(null);
    if (!validation.valid) return;
    create.mutate(toCreateRequest(form), {
      onSuccess: (res) => {
        toast({ title: "Family created", variant: "success" });
        onClose();
        setForm(emptyForm());
        setShowErrors(false);
        setServerCells({});
        router.push(`/products/${res.family.id}`);
      },
      onError: (err) => {
        const conflicts = getFamilyConflicts(err);
        if (conflicts?.kind === "ROWS") {
          setServerCells(conflicts.cells);
          setFamilyServerMessages(conflicts.familyMessages);
          setSummary(conflicts.summary);
          return;
        }
        const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data
          ?.code;
        if (code === API_ERROR_CODES.FAMILY_COPY_PRICE_REQUIRED) {
          setPriceServerMessage(COPY_PRICE_NEEDS_PRICE_MSG);
          return;
        }
        const formulaCopy = safeTextErrorCopy(err);
        if (formulaCopy) {
          setFamilyServerMessages([formulaCopy]);
          return;
        }
        toast({ title: "Couldn't create the family. Please try again.", variant: "error" });
      },
    });
  };

  const field = (
    label: string,
    key: keyof Pick<
      FamilyForm,
      "name" | "category" | "description" | "pricePerUnit" | "standardCost"
    >,
    error?: string,
    opts?: { placeholder?: string },
  ) => (
    <label className="flex flex-col gap-1 text-sm font-medium text-navy">
      {label}
      <input
        aria-label={label}
        aria-invalid={error ? "true" : undefined}
        value={form[key]}
        placeholder={opts?.placeholder}
        onChange={(e) => {
          const value = e.target.value;
          // Clearing the family price drops "copy it onto the variants" (it would copy nothing: $0.00).
          setForm((f) => ({
            ...f,
            [key]: value,
            ...(key === "pricePerUnit" && !value.trim() ? { copyFamilyPrice: false } : {}),
          }));
          if (key === "name") setFamilyServerMessages([]);
        }}
        className="rounded border border-surface-border bg-white px-2 py-1.5 text-sm font-normal focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      {error && <span className="text-xs font-normal text-danger">{error}</span>}
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      title="New family"
      description="A family groups variants (flavors, sizes). It is a container: you sell and stock its variants."
      className="max-w-5xl"
      scroll
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Create family
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field(
            "Family name",
            "name",
            (showErrors ? validation.family.name : undefined) ?? familyServerMessages[0],
          )}
          {field("Category", "category")}
          {field(
            "Family price",
            "pricePerUnit",
            (showErrors ? validation.family.pricePerUnit : undefined) ??
              priceServerMessage ??
              undefined,
          )}
          {field(
            "Family cost",
            "standardCost",
            showErrors ? validation.family.standardCost : undefined,
            { placeholder: "Optional" },
          )}
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm text-navy">
            <input
              type="checkbox"
              checked={form.copyFamilyPrice}
              disabled={!form.pricePerUnit.trim()}
              onChange={(e) => setForm((f) => ({ ...f, copyFamilyPrice: e.target.checked }))}
            />
            Copy the family price onto the variants
          </label>
          {!form.pricePerUnit.trim() && (
            <p className="mt-1 text-xs text-navy/60">
              Enter a family price to copy it onto the variants.
            </p>
          )}
        </div>
        {summary && (Object.keys(serverCells).length > 0 || familyServerMessages.length > 0) && (
          <p role="alert" className="rounded bg-danger-bg px-3 py-2 text-sm text-danger">
            {summary}
          </p>
        )}
        {showErrors && validation.formError && (
          <p role="alert" className="text-sm text-danger">
            {validation.formError}
          </p>
        )}
        <FamilyVariantsGrid
          rows={form.rows}
          onChange={setRows}
          cellMessages={cellMessages}
          onCodeBlur={onCodeBlur}
          disabled={create.isPending}
        />
      </div>
    </Modal>
  );
}
