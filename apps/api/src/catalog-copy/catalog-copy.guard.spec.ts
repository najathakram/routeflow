import {
  CopyRefusal,
  assertApplyAllowed,
  assertConfirmed,
  assertNoRecipesLeftOut,
  assertStorageForApply,
  parseCopyArgs,
} from "./catalog-copy.guard";

/**
 * SA-1027 rule 5: arguments and guards. Slugs are `acme`-style placeholders; the only real-looking test slugs
 * are the approved ones (`test`, `qa-*`, `e2e-*`).
 */
const base = ["--source", "acme-source", "--target", "qa-copy-1"];

describe("catalog copy args (SA-1027 rule 5)", () => {
  it("parses source and target, dry run by default", () => {
    expect(parseCopyArgs(base)).toMatchObject({
      source: "acme-source",
      target: "qa-copy-1",
      apply: false,
    });
  });

  it("has no defaults: a missing source or target is refused", () => {
    expect(() => parseCopyArgs(["--target", "qa-copy-1"])).toThrow(CopyRefusal);
    expect(() => parseCopyArgs(["--source", "acme-source"])).toThrow(CopyRefusal);
  });

  it("refuses source equal to target", () => {
    expect(() => parseCopyArgs(["--source", "qa-x", "--target", "qa-x"])).toThrow(CopyRefusal);
  });

  it("refuses an unknown flag and a retired-style flag instead of ignoring it", () => {
    expect(() => parseCopyArgs([...base, "--force"])).toThrow(/unknown argument/);
  });

  it("reads --live-tenant-override=<slug>, --confirm and --resume", () => {
    const a = parseCopyArgs([
      ...base,
      "--apply",
      "--live-tenant-override=qa-copy-1",
      "--confirm",
      "COPY 3 PRODUCTS",
      "--resume",
      "m.json",
    ]);
    expect(a).toMatchObject({
      apply: true,
      liveTenantOverride: "qa-copy-1",
      confirm: "COPY 3 PRODUCTS",
      resume: "m.json",
    });
  });
});

describe("C-R1: --apply on a non-test target needs the override, before any read", () => {
  it("is refused with no override (0 reads, 0 writes)", () => {
    const args = parseCopyArgs(["--source", "qa-a", "--target", "acme-live-1", "--apply"]);
    expect(() => assertApplyAllowed(args)).toThrow(CopyRefusal);
    expect(() => assertApplyAllowed(args)).toThrow(/live-tenant-override/);
  });

  it("is refused when the override names a different slug", () => {
    const args = parseCopyArgs([
      "--source",
      "qa-a",
      "--target",
      "acme-live-1",
      "--apply",
      "--live-tenant-override=acme-other",
    ]);
    expect(() => assertApplyAllowed(args)).toThrow(CopyRefusal);
  });

  it("lets a test target apply with nothing more, and a dry run never needs a guard", () => {
    expect(() =>
      assertApplyAllowed(parseCopyArgs(["--source", "acme-a", "--target", "qa-b", "--apply"])),
    ).not.toThrow();
    expect(() =>
      assertApplyAllowed(parseCopyArgs(["--source", "acme-a", "--target", "acme-live-1"])),
    ).not.toThrow();
  });

  it("lets a live target through to the confirmation step with the override", () => {
    expect(() =>
      assertApplyAllowed(
        parseCopyArgs([
          "--source",
          "qa-a",
          "--target",
          "acme-live-1",
          "--apply",
          "--live-tenant-override=acme-live-1",
        ]),
      ),
    ).not.toThrow();
  });
});

describe("C-G8: --confirm must carry the dry run's create count", () => {
  const live = (confirm?: string) =>
    parseCopyArgs([
      "--source",
      "qa-a",
      "--target",
      "acme-live-1",
      "--apply",
      "--live-tenant-override=acme-live-1",
      ...(confirm ? ["--confirm", confirm] : []),
    ]);

  it("passes on the exact line", () => {
    expect(() => assertConfirmed(live("COPY 12 PRODUCTS"), 12)).not.toThrow();
  });

  it("is refused on a different count, a missing line or a loose spelling", () => {
    expect(() => assertConfirmed(live("COPY 11 PRODUCTS"), 12)).toThrow(CopyRefusal);
    expect(() => assertConfirmed(live(), 12)).toThrow(CopyRefusal);
    expect(() => assertConfirmed(live("copy 12 products"), 12)).toThrow(CopyRefusal);
  });

  it("a test target needs no confirmation", () => {
    const args = parseCopyArgs(["--source", "acme-a", "--target", "qa-b", "--apply"]);
    expect(() => assertConfirmed(args, 12)).not.toThrow();
  });
});

describe("C-G16: --apply refuses while the source holds recipe products", () => {
  it("passes with no recipe", () => {
    expect(() => assertNoRecipesLeftOut([])).not.toThrow();
  });

  it("refuses and names the recipes", () => {
    expect(() => assertNoRecipesLeftOut(["R-1", "R-2"])).toThrow(CopyRefusal);
    expect(() => assertNoRecipesLeftOut(["R-1", "R-2"])).toThrow(/R-1, R-2/);
    expect(() => assertNoRecipesLeftOut(["R-1", "R-2"])).toThrow(/nothing was written/);
  });

  it("names the first 20 and counts the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => "R-" + i);
    expect(() => assertNoRecipesLeftOut(many)).toThrow(/R-19.*[+]5 more/);
  });
});

// The first live dry run printed "R2 credentials not configured - falling back to local disk storage": under a
// `railway run --service postgres` shell an APPLY would have copied the photos to the operator's disk, leaving the
// target's product rows pointing at objects that exist nowhere durable.
describe("C-G18: --apply against a real (proxy) database refuses without R2 configured", () => {
  const r2 = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };
  const apply = (target: string) =>
    parseCopyArgs(["--source", "qa-a", "--target", target, "--apply"]);

  it("refuses, naming each missing variable, when none is set", () => {
    expect(() => assertStorageForApply(apply("qa-copy-1"), {}, false)).toThrow(CopyRefusal);
    expect(() => assertStorageForApply(apply("qa-copy-1"), {}, false)).toThrow(
      /R2_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/,
    );
  });

  it("refuses when one is blank", () => {
    expect(() =>
      assertStorageForApply(apply("qa-copy-1"), { ...r2, R2_SECRET_ACCESS_KEY: "" }, false),
    ).toThrow(/R2_SECRET_ACCESS_KEY/);
  });

  it("passes with all three set", () => {
    expect(() => assertStorageForApply(apply("qa-copy-1"), r2, false)).not.toThrow();
  });

  it("a --local (docker-compose) run keeps local disk storage", () => {
    expect(() => assertStorageForApply(apply("qa-copy-1"), {}, true)).not.toThrow();
  });

  it("a dry run needs no storage", () => {
    const dry = parseCopyArgs(["--source", "qa-a", "--target", "acme-live-1"]);
    expect(() => assertStorageForApply(dry, {}, false)).not.toThrow();
  });

  it("--resume (photos only) needs it too", () => {
    const resume = parseCopyArgs([
      "--source",
      "qa-a",
      "--target",
      "qa-copy-1",
      "--apply",
      "--resume",
      "m.json",
    ]);
    expect(() => assertStorageForApply(resume, {}, false)).toThrow(CopyRefusal);
  });
});
