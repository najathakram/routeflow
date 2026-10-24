import test from "node:test";
import assert from "node:assert/strict";
import {
  fileToArea,
  DOMAINS,
  areaDomain,
  guessDomainFromText,
  buildAreaTree,
} from "../lib/areas.mjs";

const area = (p) => fileToArea(p).area;

test("fileToArea: api", () => {
  assert.deepEqual(fileToArea("apps/api/src/invoices/invoices.service.ts"), {
    area: "api:invoices",
    layer: "api",
    name: "invoices",
  });
  assert.equal(area("apps/api/src/main.ts"), "api:_core");
  assert.equal(area("apps/api/src/orders/dto/create.dto.ts"), "api:orders");
  assert.equal(area("apps/api/prisma/schema/sales.prisma"), "api:prisma");
  assert.equal(area("apps/api/scripts/schema-drift.mjs"), "api:scripts");
  assert.equal(area("apps/api/package.json"), "api:_core");
});

test("fileToArea: web skips groups and params, uses first dir not the file", () => {
  assert.equal(area("apps/web/app/(dashboard)/routes/page.tsx"), "web:routes");
  assert.equal(area("apps/web/app/(dashboard)/routes/templates/[id]/page.tsx"), "web:routes");
  assert.equal(area("apps/web/app/(dashboard)/[tenant]/orders/[...slug]/page.tsx"), "web:orders");
  assert.equal(area("apps/web/app/layout.tsx"), "web:_shell");
  assert.equal(area("apps/web/app/(auth)/page.tsx"), "web:_shell");
  assert.equal(area("apps/web/components/products/row.tsx"), "web:products");
  assert.equal(area("apps/web/components/button.tsx"), "web:_components");
  assert.equal(area("apps/web/lib/api.ts"), "web:_lib");
  assert.equal(area("apps/web/e2e/orders.spec.ts"), "web:e2e");
  assert.equal(area("apps/web/next.config.js"), "web:_other");
});

test("fileToArea: mobile, packages, infra, backslashes", () => {
  assert.equal(area("apps/mobile/app/(driver)/stops.tsx"), "mobile:driver");
  assert.equal(area("apps/mobile/app/_layout.tsx"), "mobile:_shell");
  assert.equal(area("apps/mobile/lib/api.ts"), "mobile:_lib");
  assert.equal(area("packages/pricing/src/index.ts"), "pkg:pricing");
  assert.equal(area(".github/workflows/ci.yml"), "infra:.github");
  assert.equal(area("tools/ops-monitor/lib/x.mjs"), "infra:tools");
  assert.equal(area("package.json"), "infra:_root");
  assert.equal(area("apps\\web\\app\\(dashboard)\\routes\\page.tsx"), "web:routes");
  assert.equal(fileToArea("packages/pricing/src/index.ts").layer, "pkg");
});

test("areaDomain", () => {
  assert.equal(areaDomain("api:invoices"), "finance");
  assert.equal(areaDomain("web:order-templates"), "orders");
  assert.equal(areaDomain("api:products"), "catalog");
  assert.equal(areaDomain("api:billing"), "billing");
  assert.equal(areaDomain("web:routes"), "delivery");
  assert.equal(areaDomain("api:customers"), "customers");
  assert.equal(areaDomain("api:_core"), "platform");
  assert.equal(areaDomain("api:scripts"), "tooling");
  assert.equal(areaDomain("infra:.github"), "tooling");
  assert.equal(areaDomain("pkg:eslint-config"), "tooling");
  assert.equal(areaDomain("pkg:pricing"), "catalog");
  assert.equal(areaDomain("api:something-new"), "other");
  assert.equal(areaDomain("domain:finance"), "finance");
  assert.equal(areaDomain("domain:nope"), "other");
  assert.equal(areaDomain(null), "other");
});

test("DOMAINS ordered with labels", () => {
  assert.deepEqual(
    DOMAINS.map((d) => d.label),
    [
      "Orders & sales",
      "Catalog & stock",
      "Finance",
      "Billing & plans",
      "Routes & delivery",
      "Customers",
      "Platform & admin",
      "Tooling & ops",
      "Other",
    ],
  );
});

test("guessDomainFromText: first matching domain in order, else null", () => {
  assert.equal(guessDomainFromText("K11 product page price editing"), "catalog");
  assert.equal(guessDomainFromText("Credit note rounding"), "finance");
  assert.equal(guessDomainFromText("Stripe trial lock"), "billing");
  assert.equal(guessDomainFromText("Counter sales walk-in"), "orders");
  assert.equal(guessDomainFromText("Dispatch route scan"), "delivery");
  assert.equal(guessDomainFromText("Buyer CRM email"), "customers");
  assert.equal(guessDomainFromText("Password reset login"), "platform");
  assert.equal(guessDomainFromText("CI hook for lane"), "tooling");
  assert.equal(guessDomainFromText("Something unrelated"), null);
  assert.equal(guessDomainFromText(undefined), null);
  // order: "invoice" (finance) wins over "order" (orders) because finance precedes... orders is
  // listed after finance in the keyword map
  assert.equal(guessDomainFromText("order invoice mismatch"), "finance");
});

test("buildAreaTree: counts files, groups by domain, sorts by layer then name", () => {
  const tree = buildAreaTree([
    "apps/api/src/invoices/a.ts",
    "apps/api/src/invoices/b.ts",
    "apps/web/app/(dashboard)/invoices/page.tsx",
    "apps/api/src/credit-notes/a.ts",
    "apps/mobile/app/(driver)/x.tsx",
    ".github/workflows/ci.yml",
  ]);
  assert.deepEqual(
    tree.domains.map((d) => d.id),
    DOMAINS.map((d) => d.id),
  );
  const fin = tree.domains.find((d) => d.id === "finance");
  assert.deepEqual(
    fin.areas.map((a) => [a.area, a.files]),
    [
      ["api:credit-notes", 1],
      ["api:invoices", 2],
      ["web:invoices", 1],
    ],
  );
  const tooling = tree.domains.find((d) => d.id === "tooling");
  assert.deepEqual(
    tooling.areas.map((a) => a.area),
    ["infra:.github"],
  );
  assert.equal(tree.domains.find((d) => d.id === "delivery").areas[0].area, "mobile:driver");
  assert.equal(fin.label, "Finance");
});
