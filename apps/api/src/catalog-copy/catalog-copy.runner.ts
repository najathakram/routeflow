import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { CatalogCopyModule } from "./catalog-copy.module";
import { CatalogCopyService, type CopyReport, type Manifest } from "./catalog-copy.service";
import { type CopyArgs } from "./catalog-copy.guard";

export interface RunnerHooks {
  beforeWrite?: (info: { targetTenantId: string; createCount: number }) => Promise<void>;
  log?: (line: string) => void;
}

/** First N entries, then a count of the rest: the full lists live in the manifest (G6). */
const head = (list: readonly string[], n = 20) =>
  list.length <= n ? list.join(", ") : `${list.slice(0, n).join(", ")} … +${list.length - n} more`;

export function formatReport(r: CopyReport): string[] {
  const lines = [
    `catalog-copy ${r.mode}`,
    `  source products read (active): ${r.sourceProducts}`,
    `  inactive left out: ${r.inactiveLeftOut}${r.inactiveLeftOut ? ` (${head(r.inactiveLeft)})` : ""}`,
    `  to create: ${r.toCreate} product(s) in ${r.families} group(s)`,
    `  skipped by SKU: ${r.skippedBySku.length}   skipped by name: ${r.skippedByName}   variants skipped: ${r.variantsSkipped.length}`,
    `  regulated left out: ${r.regulated}${r.regulated ? ` (${head(r.regulatedIds)})` : ""}`,
    `  codes dropped (already used at the target): ${r.codesDropped.length}`,
    `  pack-only (target has no ${r.unitsV1 ? "ladder writer" : "units_v1"}): ${r.packOnly.length}`,
    `  recipes left out: ${r.recipesLeftOut.length}${r.recipesLeftOut.length ? ` (${head(r.recipesLeftOut)})` : ""}`,
    `  photos to copy: ${r.photos}`,
    "  columns that will differ (the target keeps its default):",
    ...Object.entries(r.differs).map(
      ([col, list]) => `    ${col}: ${list.length}${list.length ? ` (${head(list)})` : ""}`,
    ),
  ];
  if (r.skippedBySku.length) lines.push(`  first skipped SKUs: ${head(r.skippedBySku)}`);
  if (r.mode === "apply") {
    lines.push(
      `  created: ${r.created}   photos copied: ${r.photosCopied}   errors: ${r.errors?.length ?? 0}`,
    );
    for (const e of r.errors ?? []) lines.push(`    ${e.kind} error ${e.rootId}: ${e.message}`);
  }
  return lines;
}

/** 0 ok; 3 the run finished but left error rows (a family not copied, or an undo that could not remove its rows). */
export function exitCodeFor(result: CopyReport | { photosCopied: number }): number {
  return "errors" in result && (result.errors?.length ?? 0) > 0 ? 3 : 0;
}

export function writeManifest(path: string, manifest: Manifest, extra?: Partial<CopyReport>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...manifest, ...(extra ? { report: extra } : {}) }, null, 2),
  );
}

/**
 * Boots the script-only module (`createApplicationContext`: no HTTP server, no websocket server, no scheduler) and
 * runs the copy. The CLI (`scripts/catalog-copy.mjs`) calls this from `dist`.
 */
export async function runCatalogCopy(
  args: CopyArgs,
  manifestPath: string,
  hooks: RunnerHooks = {},
): Promise<CopyReport | { photosCopied: number }> {
  const log = hooks.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const app = await NestFactory.createApplicationContext(CatalogCopyModule, {
    logger: ["error", "warn"],
  });
  try {
    const service = app.get(CatalogCopyService);
    if (args.resume) {
      const manifest = JSON.parse(readFileSync(resolve(args.resume), "utf8")) as Manifest;
      const done = await service.resumePhotos(manifest, args);
      writeManifest(args.resume, manifest);
      log(`catalog-copy resume: photos copied ${done.photosCopied}`);
      return done;
    }
    const report = await service.run(args, {
      beforeWrite: hooks.beforeWrite,
      onManifest: (m) => writeManifest(manifestPath, m),
    });
    for (const l of formatReport(report)) log(l);
    if (report.manifest) {
      writeManifest(manifestPath, report.manifest);
      log(`  manifest: ${manifestPath}`);
    }
    return report;
  } finally {
    await app.close();
  }
}
