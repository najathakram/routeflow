import { isTestTenantSlug } from "../common/test-tenant-slug";

/**
 * SA-1027 rule 5: the arguments and guards of the catalog-copy script. Pure: no Nest, no database, so the refusals
 * are testable and run before the script reads a single row. Source and target are arguments only; nothing here (or
 * anywhere in the script) names a tenant.
 */
export class CopyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRefusal";
  }
}

export interface CopyArgs {
  source: string;
  target: string;
  apply: boolean;
  /** `--live-tenant-override=<slug>`: must equal the target slug to write a non-test target. */
  liveTenantOverride?: string;
  /** `--confirm "COPY <n> PRODUCTS"`: `<n>` is the dry run's create count. */
  confirm?: string;
  /** `--resume <manifest>`: finish the photos of products that manifest says this run created. */
  resume?: string;
}

const VALUE_FLAGS = new Set(["--source", "--target", "--confirm", "--resume"]);

export function parseCopyArgs(argv: readonly string[]): CopyArgs {
  const out: Partial<CopyArgs> = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") {
      out.apply = true;
    } else if (a.startsWith("--live-tenant-override=")) {
      out.liveTenantOverride = a.slice("--live-tenant-override=".length);
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new CopyRefusal(`${a} needs a value`);
      i += 1;
      if (a === "--source") out.source = v;
      else if (a === "--target") out.target = v;
      else if (a === "--confirm") out.confirm = v;
      else out.resume = v;
    } else {
      throw new CopyRefusal(`unknown argument: ${a}`);
    }
  }
  if (!out.source) throw new CopyRefusal("--source <slug> is required (there is no default)");
  if (!out.target) throw new CopyRefusal("--target <slug> is required (there is no default)");
  if (out.source === out.target) throw new CopyRefusal("source and target must differ");
  return out as CopyArgs;
}

/**
 * Called before ANY read of the target's rows. `--apply` on a test target needs nothing more; on any other target it
 * needs `--live-tenant-override=<the same target slug>`. A dry run is never gated here.
 */
export function assertApplyAllowed(args: CopyArgs): void {
  if (!args.apply || isTestTenantSlug(args.target)) return;
  if (args.liveTenantOverride !== args.target) {
    throw new CopyRefusal(
      "refused: --apply on a non-test target needs --live-tenant-override=<the target slug> (and a --confirm line)",
    );
  }
}

/** The exact typed line for a non-test target; `n` is the dry run's create count. */
export const confirmLine = (n: number): string => `COPY ${n} PRODUCTS`;

/** Called with the dry run's create count, still before any write. A test target needs no confirmation. */
export function assertConfirmed(args: CopyArgs, createCount: number): void {
  if (!args.apply || isTestTenantSlug(args.target)) return;
  if (args.confirm !== confirmLine(createCount)) {
    throw new CopyRefusal(
      `refused: --confirm must be exactly "${confirmLine(createCount)}" (the dry run's create count)`,
    );
  }
}

/**
 * Rule 3 (SA-1027 ruling 3): the script builds no recipe product, so an apply over a source that holds one would leave a
 * catalog that quietly lacks it. It refuses before any write and names the recipes; the dry run still lists them.
 */
export function assertNoRecipesLeftOut(recipes: readonly string[]): void {
  if (recipes.length === 0) return;
  const shown =
    recipes.length <= 20
      ? recipes.join(", ")
      : `${recipes.slice(0, 20).join(", ")} … +${recipes.length - 20} more`;
  throw new CopyRefusal(
    `refused: the source holds ${recipes.length} recipe product(s) this script does not build (${shown}); nothing was written`,
  );
}
