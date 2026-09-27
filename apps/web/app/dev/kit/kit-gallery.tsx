"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Badge, Button, Input, PasswordInput, Textarea } from "@routeflow/ui/web";
import { MoneyInput } from "@/components/MoneyInput";

const VARIANTS = ["primary", "secondary", "ghost", "danger", "link"] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="overline">{title}</p>
      {children}
    </div>
  );
}

function SurfaceGallery({ surface }: { surface: "operator" | "buyer" }) {
  const [money, setMoney] = React.useState<number | null>(12.5);
  return (
    <div className={`${surface === "buyer" ? "surface-buyer " : ""}flex flex-col gap-6 py-4`}>
      <h2 className="text-heading-2 text-ink-900">{surface} surface</h2>
      <Section title="Buttons · md">
        <div className="flex flex-wrap items-center gap-2">
          {VARIANTS.map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </div>
      </Section>
      <Section title="Sizes · states">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" leftIcon={<Plus className="h-4 w-4" />}>
            New order
          </Button>
          <Button variant="ghost" aria-label="Add" className="w-[34px] px-0">
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="secondary" aria-label="Add" className="w-[34px] px-0">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </Section>
      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge status="DELIVERED" />
          <Badge status="PENDING" />
          <Badge status="OVERDUE" />
          <Badge status="OUT_FOR_DELIVERY" />
          <Badge status="DRAFT" />
        </div>
      </Section>
      <Section title="Fields">
        <Input label="Business name" placeholder="Acme Market" />
        <div className="flex flex-col gap-1">
          <Input label="Email" defaultValue="buyer@acme.test" />
          <p className="text-xs text-ink-500">We send order updates here.</p>
        </div>
        <Input label="Phone" defaultValue="555-01" error="Enter a full phone number." />
        <Input label="Account code" defaultValue="ACME-01" disabled />
        <PasswordInput label="Password" defaultValue="correct-horse" />
        <Textarea label="Delivery notes" placeholder="Side door, ring twice" />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-navy">Unit price</label>
          <MoneyInput value={money} onChange={setMoney} />
        </div>
      </Section>
    </div>
  );
}

export function KitGallery() {
  return (
    <main className="min-h-screen bg-surface-raised p-4">
      <SurfaceGallery surface="operator" />
      <SurfaceGallery surface="buyer" />
    </main>
  );
}
