"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useReadOnlyGate } from "@/lib/read-only-gate";
import { productsText } from "@/lib/rule-chooser";
import { NewRuleFromCatalog } from "./NewRuleFromCatalog";
import { RuleChooserDialog } from "./RuleChooserDialog";

type Action = "new" | "add" | "remove";

const ITEM =
  "flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm text-navy outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised";

/**
 * The catalog bulk bar's ONE "Restrict…" menu (row 509 PR5), beside "Limit in portal…" and under the same gate
 * (TENANT_ADMIN and OPERATOR; the server is the authority). One calm menu instead of three buttons: New rule with N
 * products… / Add to a rule… / Remove from a rule…. Read-only workspaces see it disabled, never hidden.
 */
export function RestrictMenu({
  selected,
  names,
  onDone,
}: {
  selected: Set<string>;
  /** id -> display name for the products the page holds; the rule editor labels its chips from this. */
  names: Record<string, string>;
  onDone: () => void;
}) {
  const role = useAuth().user?.role;
  const gate = useReadOnlyGate();
  const [action, setAction] = React.useState<Action | null>(null);
  if (role !== "TENANT_ADMIN" && role !== "OPERATOR") return null;
  const ids = Array.from(selected);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            variant="secondary"
            rightIcon={<ChevronDown className="h-4 w-4" aria-hidden />}
            disabled={gate.readOnly}
            aria-describedby={gate.readOnly ? gate.hintId : undefined}
            title={gate.readOnly ? (gate.line ?? undefined) : undefined}
            data-testid="restrict-menu-open"
            className="max-sm:h-11"
          >
            Restrict…
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-[14rem] rounded-lg border border-surface-border bg-white p-1 shadow-dropdown"
          >
            <DropdownMenu.Item className={cn(ITEM)} onSelect={() => setAction("new")}>
              {`New rule with ${productsText(ids.length)}…`}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={cn(ITEM)} onSelect={() => setAction("add")}>
              Add to a rule…
            </DropdownMenu.Item>
            <DropdownMenu.Item className={cn(ITEM)} onSelect={() => setAction("remove")}>
              Remove from a rule…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {action === "new" && (
        <NewRuleFromCatalog
          productIds={ids}
          names={names}
          onClose={() => setAction(null)}
          onCreated={onDone}
        />
      )}
      {(action === "add" || action === "remove") && (
        <RuleChooserDialog
          open
          mode={action}
          productIds={ids}
          onClose={() => setAction(null)}
          onDone={onDone}
        />
      )}
    </>
  );
}
