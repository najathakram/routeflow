/**
 * B1214: a barcode claim, its availability check and its advisory-lock keys all use the SAME equivalence scan lookup
 * uses (`gtinEquivalents`, derived from the `normalizeScanCode` rules in @routeflow/scanning): a 12-digit UPC-A and
 * the same code with a leading zero (EAN-13) are ONE label (iOS reports a UPC-A as EAN-13), so two ACTIVE products
 * can never hold them, and the two claimants lock the same keys.
 */
import { ConflictException } from "@nestjs/common";
import { normalizeScanCode } from "@routeflow/scanning";
import {
  assertBarcodeAvailable,
  barcodeEquivalents,
  lockBarcodeCodes,
} from "./product-catalog-sync";
import { claimCodes } from "./product-code-release";
import { ACTOR, T, makeTx, product, row } from "./product-code-release.fake-tx";
import { API_ERROR_CODES } from "../common/api-error-codes";

const UPC = "012345678905"; // 12 digits (UPC-A)
const EAN = `0${UPC}`; // the same label as an EAN-13

/** The keys `lockBarcodeCodes` took, in order. */
async function lockedKeys(codes: string[]): Promise<string[]> {
  const keys: string[] = [];
  const tx = {
    $executeRaw: jest.fn((_s: TemplateStringsArray, ...v: unknown[]) => {
      if (v[0] === "product-barcode") keys.push(String(v[1]).split(":")[1]);
      return Promise.resolve(1);
    }),
  };
  await lockBarcodeCodes(tx, T, codes);
  return keys;
}

describe("barcodeEquivalents (the one equivalence)", () => {
  it("a UPC-A and its EAN-13 form are each other's equivalents", () => {
    expect(barcodeEquivalents(UPC)).toEqual(expect.arrayContaining([UPC, EAN]));
    expect(barcodeEquivalents(EAN)).toEqual(expect.arrayContaining([UPC, EAN]));
  });

  it("every equivalent is one of the candidates scan lookup would try for the same code", () => {
    for (const code of [UPC, EAN, "0012345678905", "01234565"]) {
      const scan = new Set(normalizeScanCode(code));
      for (const e of barcodeEquivalents(code)) expect(scan.has(e)).toBe(true);
    }
  });

  it("the fuzzy fallback tiers are NOT identity: no leading-zero strip, no check-digit strip", () => {
    const eq = barcodeEquivalents(UPC);
    expect(eq).not.toContain("12345678905"); // leading zero stripped
    expect(eq).not.toContain(UPC.slice(0, -1)); // check digit stripped
    expect(barcodeEquivalents("00123")).toEqual(["00123"]);
  });

  it("a non-numeric code is its own only equivalent", () => {
    expect(barcodeEquivalents("TOM-001")).toEqual(["TOM-001"]);
  });
});

describe("lockBarcodeCodes: the lock keys are the equivalence classes", () => {
  it("a UPC and its EAN-13 form take the SAME keys, in one ascending batch", async () => {
    const a = await lockedKeys([UPC]);
    const b = await lockedKeys([EAN]);
    expect(a).toEqual(b);
    expect(a).toEqual([EAN, UPC].sort());
  });

  it("unrelated codes still take only their own key", async () => {
    expect(await lockedKeys(["M1", "A1"])).toEqual(["A1", "M1"]);
  });
});

describe("assertBarcodeAvailable: an equivalent holder is a 409 BARCODE_TAKEN", () => {
  const claim = (tx: ReturnType<typeof makeTx>, code: string, productId: string | null) =>
    assertBarcodeAvailable(tx, { tenantId: T, productId, code });
  const codeOf = async (p: Promise<unknown>) =>
    ((await p.catch((e) => e)) as ConflictException).getResponse?.();

  it("the 13-digit form of a code a product already holds as a 12-digit UPC", async () => {
    const tx = makeTx({ products: [product({ id: "p1", barcode: UPC })] });
    expect(await codeOf(claim(tx, EAN, "p2"))).toMatchObject({
      code: API_ERROR_CODES.BARCODE_TAKEN,
      productId: "p1",
    });
  });

  it("the 12-digit UPC of a code held as a ProductBarcode row in its EAN-13 form", async () => {
    const tx = makeTx({
      products: [product({ id: "p1" })],
      barcodes: [row("r1", "p1", "UNIT", EAN)],
    });
    expect(await codeOf(claim(tx, UPC, null))).toMatchObject({
      code: API_ERROR_CODES.BARCODE_TAKEN,
      productId: "p1",
    });
  });

  it("the same product re-claiming its own equivalent is not a conflict", async () => {
    const tx = makeTx({ products: [product({ id: "p1", barcode: UPC })] });
    await expect(claim(tx, EAN, "p1")).resolves.toBeUndefined();
  });

  it("a different code that merely shares a stripped form is NOT a conflict", async () => {
    const tx = makeTx({ products: [product({ id: "p1", barcode: "12345678905" })] });
    await expect(claim(tx, UPC, "p2")).resolves.toBeUndefined();
  });
});

describe("claimCodes: the claim path sees the equivalent holder", () => {
  it("an ACTIVE holder of the equivalent form is a 409 BARCODE_TAKEN naming it", async () => {
    const tx = makeTx({ products: [product({ id: "p1", barcode: UPC })] });
    const err = await claimCodes(tx, {
      tenantId: T,
      productId: "p2",
      actorId: ACTOR,
      codes: [{ field: "barcode", value: EAN }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.BARCODE_TAKEN,
      productId: "p1",
    });
  });

  it("an INACTIVE holder of the equivalent form is released (its own code, audited), so it cannot come back live", async () => {
    const tx = makeTx({
      products: [product({ id: "old", isActive: false, barcode: UPC })],
      barcodes: [row("r1", "old", "UNIT", UPC)],
    });
    await claimCodes(tx, {
      tenantId: T,
      productId: "p2",
      actorId: ACTOR,
      codes: [{ field: "barcode", value: EAN }],
    });
    expect(tx.products[0]).toMatchObject({ barcode: null, retiredBarcode: UPC });
    expect(tx.barcodes[0]).toMatchObject({ code: null, retiredCode: UPC });
    expect(tx.audits).toHaveLength(1);
    expect(tx.audits[0].data.meta).toMatchObject({ codes: [UPC] });
  });

  it("a unitSku holder of the equivalent spelling blocks a barcode claim, and the other way round", async () => {
    const tx = makeTx({ products: [product({ id: "p1", unitSku: UPC })] });
    const err = await claimCodes(tx, {
      tenantId: T,
      productId: "p2",
      actorId: ACTOR,
      codes: [{ field: "barcode", value: EAN }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ productId: "p1" });
    const tx2 = makeTx({ products: [product({ id: "p1", barcode: UPC })] });
    const err2 = await claimCodes(tx2, {
      tenantId: T,
      productId: "p2",
      actorId: ACTOR,
      codes: [{ field: "unitSku", value: EAN }],
    }).catch((e) => e);
    expect(err2).toBeInstanceOf(ConflictException);
    expect(err2.getResponse()).toMatchObject({ productId: "p1" });
  });
});
