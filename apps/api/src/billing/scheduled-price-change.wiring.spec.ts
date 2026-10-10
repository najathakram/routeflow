/**
 * R1 option B - DI wiring pin. BillingService, SubscriptionMutationService and PlatformAdminService take
 * ScheduledPriceChangeService as an @Optional() trailing collaborator (so the dozens of spec constructors that
 * predate it keep compiling). That makes a MISSING provider silent: Nest would inject `undefined`, the
 * `invoice.upcoming` push, the resume() restore and the restore-first step would quietly never run in production.
 * This pin makes that impossible: every module that instantiates one of them must PROVIDE the service, or import a
 * module that EXPORTS it. Reads the real modules' metadata - no database, no network.
 */
import * as fs from "fs";
import * as path from "path";
import "reflect-metadata";
import { BillingModule } from "./billing.module";
import { BillingService } from "./billing.service";
import { BillingCronService } from "./billing-cron.service";
import { ScheduledPriceChangeService } from "./scheduled-price-change";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";

const meta = (key: string, target: object): unknown[] => Reflect.getMetadata(key, target) ?? [];
const SRC = path.resolve(__dirname, "..");

describe("ScheduledPriceChangeService is provided wherever its consumers are instantiated", () => {
  it("BillingModule provides it AND exports it (PlatformAdminModule gets it through its BillingModule import)", () => {
    expect(meta("providers", BillingModule)).toContain(ScheduledPriceChangeService);
    expect(meta("exports", BillingModule)).toContain(ScheduledPriceChangeService);
    expect(meta("imports", PlatformAdminModule)).toContain(BillingModule);
  });

  it("each consumer declares it as a constructor dependency (a renamed or dropped param fails here)", () => {
    for (const cls of [BillingService, SubscriptionMutationService, PlatformAdminService]) {
      const types = Reflect.getMetadata("design:paramtypes", cls) as unknown[];
      expect(types).toContain(ScheduledPriceChangeService);
    }
    // The cron takes it as a REQUIRED collaborator.
    expect(Reflect.getMetadata("design:paramtypes", BillingCronService)).toContain(
      ScheduledPriceChangeService,
    );
  });

  it("every consumer in a *.module.ts is covered: its module provides the service or imports one that exports it", () => {
    const modules: { file: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(full);
        } else if (e.name.endsWith(".module.ts")) {
          modules.push({
            file: path.relative(SRC, full).split(path.sep).join("/"),
            text: fs.readFileSync(full, "utf8"),
          });
        }
      }
    };
    walk(SRC);

    const consumers =
      /\b(BillingService|SubscriptionMutationService|PlatformAdminService|BillingCronService)\b/;
    // Comments stripped: a comment that merely NAMES a service inside `providers: [...]` is not an instantiation.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const providersOf = (text: string) => /providers:\s*\[([\s\S]*?)\]/.exec(code(text))?.[1] ?? "";
    const offenders: string[] = [];
    for (const m of modules) {
      if (!consumers.test(providersOf(m.text))) continue; // only modules that INSTANTIATE a consumer
      const provides = /\bScheduledPriceChangeService\b/.test(providersOf(m.text));
      const imports = /\bBillingModule\b/.test(m.text); // BillingModule exports it (pinned above)
      if (!provides && !imports) offenders.push(m.file);
    }
    expect(offenders).toEqual([]);
    // ... and the scan really sees the two production modules.
    const scanned = modules
      .filter((m) => consumers.test(providersOf(m.text)))
      .map((m) => m.file)
      .sort();
    expect(scanned).toEqual([
      "billing/billing.module.ts",
      "platform-admin/platform-admin.module.ts",
    ]);
  });
});
