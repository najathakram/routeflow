import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { StatementPdfService } from "./statement-pdf.service";

/**
 * SA-1209 D3 (SA-1210 G2): the statement PDFs' "Generated" stamp prints through asOfText in the tenant's zone, with the
 * zone named. Both statement templates share StatementFooter, so one footer covers both. Jest has no .tsx transform, so the
 * real footer is compiled here and its element tree read (as invoice-pdf-rows.spec.ts does). The clock is an argument (L-353).
 */
function loadShared() {
  const file = path.join(__dirname, "statement-pdf-shared.tsx");
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2021,
    },
  });
  const load = (id: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(id.startsWith(".") ? path.resolve(__dirname, id) : id);
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", outputText)(load, mod, mod.exports);
  return mod.exports;
}

const { StatementFooter } = loadShared();

const textsOf = (node: any): string[] => {
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (node && typeof node === "object" && "props" in node) return textsOf(node.props?.children);
  return [];
};

const GENERATED_AT = new Date("2026-11-21T22:46:00.000Z");
const footerText = (tenant: Record<string, unknown> | null) =>
  textsOf(StatementFooter({ tenant, generatedAt: GENERATED_AT, styles: {} })).join("");

/**
 * A service for "tenant-1" whose config table holds that tenant's row only (Chicago). A read answers only for the tenant it
 * asks for, so a read aimed at any other tenant finds no row (and the zone falls back to UTC).
 */
function serviceWithConfig() {
  const findUnique = jest.fn(async (args: any) =>
    args.where.tenantId === "tenant-1"
      ? { businessName: "Acme", logoKey: null, timezone: "America/Chicago" }
      : null,
  );
  const prisma = { getTenantId: () => "tenant-1", tenantConfig: { findUnique } };
  return {
    service: new StatementPdfService(prisma as never, {} as never, {} as never),
    findUnique,
  };
}

describe("the statement PDF's Generated stamp (SA-1209 D3)", () => {
  it("22:46Z for a tenant in America/Chicago prints 4:46 PM CST", () => {
    expect(footerText({ businessName: "Acme", timeZone: "America/Chicago" })).toContain(
      "Generated Nov 21, 2026, 4:46 PM CST",
    );
  });

  it("no tenant zone handed prints UTC, named, never the server's zone", () => {
    expect(footerText(null)).toContain("Generated Nov 21, 2026, 10:46 PM UTC");
  });

  it("loadTenant hands the tenant's zone to both templates", async () => {
    const { service } = serviceWithConfig();
    expect((await service.loadTenant())?.timeZone).toBe("America/Chicago");
  });

  it("M3: every config read, the zone read included, is scoped to the caller's own tenant", async () => {
    const { service, findUnique } = serviceWithConfig();
    await service.loadTenant();
    const zoneReads = findUnique.mock.calls.filter(([args]: any[]) => args.select?.timezone);
    expect(zoneReads).toHaveLength(1);
    expect(zoneReads[0][0].where).toEqual({ tenantId: "tenant-1" });
    for (const [args] of findUnique.mock.calls)
      expect((args as any).where.tenantId).toBe("tenant-1");
  });
});
