import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * SA-1211 BF-7 (M1/M2): the monthly statement's money, read off the real template's element tree. Jest maps
 * `./statement-pdf-template` to a stub and has no .tsx transform, so this compiles the real template (and its .tsx
 * neighbour) here, as invoice-pdf-rows.spec.ts does. Every amount prints through fmtPdfMoney: grouped thousands, ONE
 * ASCII minus ("-$1,234.50"). The opening, closing, adjustment and activity lines keep their sign; charges, payments,
 * credits and available credit are positive by meaning and print their size.
 */
function loadTsx(file: string): Record<string, any> {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2021,
    },
  });
  const load = (id: string) => {
    if (!id.startsWith(".")) return require(id); // eslint-disable-line @typescript-eslint/no-require-imports
    const resolved = path.resolve(path.dirname(file), id);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return fs.existsSync(`${resolved}.tsx`) ? loadTsx(`${resolved}.tsx`) : require(resolved);
  };
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", outputText)(load, mod, mod.exports);
  return mod.exports;
}

const { StatementPdfTemplate } = loadTsx(path.join(__dirname, "statement-pdf-template.tsx"));

/** Every element whose children are all plain text, as the text it prints, in reading order. */
function leafTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) leafTexts(n, out);
  } else if (node && typeof node === "object" && "props" in node) {
    const children = [(node as any).props?.children].flat(Infinity).filter((c) => c != null);
    if (children.length && children.every((c) => typeof c === "string" || typeof c === "number")) {
      out.push(children.join(""));
    } else {
      leafTexts(children, out);
    }
  }
  return out;
}

const statement = (over: Record<string, unknown> = {}) => ({
  period: {
    month: "2026-10",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
    label: "October 2026",
  },
  customer: { id: "cust-1", businessName: "Acme Foods" },
  opening: 0,
  charges: 0,
  payments: 0,
  credits: 0,
  adjustments: 0,
  closing: 0,
  availableCredit: 0,
  lineItems: [] as Array<Record<string, unknown>>,
  ...over,
});

const texts = (over: Record<string, unknown> = {}) =>
  leafTexts(
    StatementPdfTemplate({
      statement: statement(over),
      tenant: null,
      generatedAt: new Date("2026-11-21T22:46:00.000Z"),
    }),
  );

/** The amount printed beside a label: the leaf right after it. */
const valueOf = (all: string[], label: string) => {
  const at = all.indexOf(label);
  expect(at).toBeGreaterThanOrEqual(0);
  return all[at + 1];
};

describe("the monthly statement PDF's money (SA-1211 BF-7)", () => {
  it("M2: an overpaid customer's closing balance keeps its minus: -$50.00", () => {
    const all = texts({ opening: 1000, payments: 1050, closing: -50 });
    expect(valueOf(all, "Closing Balance")).toBe("-$50.00");
    expect(valueOf(all, "Opening Balance")).toBe("$1,000.00");
  });

  it("M2: a negative opening balance keeps its minus too", () => {
    expect(valueOf(texts({ opening: -75, closing: -75 }), "Opening Balance")).toBe("-$75.00");
  });

  it("a positive closing balance prints as is, grouped: $5,500.00", () => {
    const all = texts({ charges: 5500, closing: 5500 });
    expect(valueOf(all, "Closing Balance")).toBe("$5,500.00");
    expect(valueOf(all, "+ Charges")).toBe("$5,500.00");
  });

  it("payments and credits are positive by meaning: they print their size, never a minus", () => {
    const all = texts({ payments: 1234.5, credits: 20 });
    expect(valueOf(all, "− Payments")).toBe("$1,234.50");
    expect(valueOf(all, "− Credits")).toBe("$20.00");
  });

  it("M1: an adjustment keeps its sign: -$12.50 and $12.50, and none prints no row", () => {
    expect(valueOf(texts({ adjustments: -12.5 }), "Adjustments")).toBe("-$12.50");
    expect(valueOf(texts({ adjustments: 12.5 }), "Adjustments")).toBe("$12.50");
    expect(texts({ adjustments: 0 })).not.toContain("Adjustments");
  });

  it("M1: activity lines keep their sign and group: a -$1,234.50 payment and a $5,500.00 invoice", () => {
    const all = texts({
      lineItems: [
        {
          date: "2026-10-05T00:00:00.000Z",
          type: "INVOICE",
          description: "Invoice INV-1",
          reference: "INV-1",
          amount: 5500,
        },
        {
          date: "2026-10-20T00:00:00.000Z",
          type: "PAYMENT",
          description: "Payment (check)",
          reference: "PAY-1",
          amount: -1234.5,
        },
      ],
    });
    expect(valueOf(all, "Invoice INV-1")).toBe("$5,500.00");
    expect(valueOf(all, "Payment (check)")).toBe("-$1,234.50");
  });

  it("available store credit prints grouped and is not signed", () => {
    expect(texts({ availableCredit: 1500 }).join("|")).toContain(
      "Available store credit: $1,500.00",
    );
  });
});
