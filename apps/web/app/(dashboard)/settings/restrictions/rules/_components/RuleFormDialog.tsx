"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { RuleTargetPicker } from "@/components/restrictions/RuleTargetPicker";
import { useCreateRestriction } from "@/lib/api/restrictions-admin-write";
import {
  emptyRuleForm,
  ruleFormSchema,
  toCreateRequest,
  type RuleFormValues,
} from "@/lib/restriction-rule-form";
import { appliesToLine, countsOf, targetCountText, type PickedTarget } from "@/lib/rule-targets";
import { RuleSettingsFields, type RuleFormErrors } from "./RuleSettingsFields";

const Legend = ({ children }: { children: React.ReactNode }) => (
  <legend className="mb-1 text-sm font-medium text-navy">{children}</legend>
);

/**
 * New-rule dialog (Lane R step 5b-2b-i). Validates with the shared form schema, then posts through
 * `useCreateRestriction`. A server refusal ("category is archived…") reaches the user through the
 * app's one global toast — this dialog adds no second message and stays open so the form is kept.
 */
export function RuleFormDialog({
  open,
  onClose,
  initialTargets,
}: {
  open: boolean;
  onClose: () => void;
  /** Products already chosen elsewhere (the catalog's "New rule with N products"). */
  initialTargets?: PickedTarget[];
}) {
  const { toast } = useToast();
  const router = useRouter();
  const create = useCreateRestriction();
  const [v, setV] = React.useState<RuleFormValues>({
    ...emptyRuleForm,
    targets: initialTargets ?? [],
  });
  const [errors, setErrors] = React.useState<RuleFormErrors>({});
  // The page mounts this only while open, so Radix has no trigger to return focus to: remember
  // who had focus and give it back on close (the BlockedLinesDialog pattern).
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const set = <K extends keyof RuleFormValues>(k: K, val: RuleFormValues[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  React.useEffect(() => {
    if (open) {
      setV({ ...emptyRuleForm, targets: initialTargets ?? [] });
      setErrors({});
    }
    // `initialTargets` seeds the form each time it opens; a new array identity must not reset typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ruleFormSchema.safeParse(v);
    if (!parsed.success) {
      const next: RuleFormErrors = {};
      for (const i of parsed.error.issues) next[i.path[0] as keyof RuleFormValues] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate(toCreateRequest(v), {
      onSuccess: (rule) => {
        const { products, labels } = countsOf(v.targets);
        toast({
          title: `Rule added · ${targetCountText(products, labels)}`,
          variant: "success",
          action: {
            label: "View",
            onClick: () => router.push(`/settings/restrictions/rules/${rule.id}`),
          },
        });
        onClose();
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New selling restriction"
      description="Stop products and labels being sold where they are banned."
      className="max-h-[92vh] overflow-y-auto"
      onOpenAutoFocus={() => {
        returnFocusTo.current = document.activeElement as HTMLElement | null;
      }}
      onCloseAutoFocus={(e) => {
        const el = returnFocusTo.current;
        returnFocusTo.current = null;
        if (el && el.isConnected && el !== document.body) {
          e.preventDefault();
          el.focus();
        }
      }}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <fieldset>
          <Legend>Applies to</Legend>
          <RuleTargetPicker
            value={v.targets}
            onChange={(t) => set("targets", t)}
            error={errors.targets}
          />
        </fieldset>

        <RuleSettingsFields v={v} set={set} errors={errors} />

        <p aria-live="polite" className="min-h-[1.25rem] text-sm font-medium text-navy">
          {appliesToLine(v.targets, v.jurisdiction, v.states)}
        </p>

        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Add rule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
