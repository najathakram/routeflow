import * as fs from "fs";
import * as path from "path";

/**
 * SA-733r6 (B4) INVENTORY pin: while a workspace is read-only the controls that WRITE stay visible but disabled with
 * the shared line (lib/read-only-gate.tsx: WriteButton / WriteLink / ReadOnlyHint). This scan reads the app source and
 * lists every control-like JSX element whose label looks like a create / record-payment action. Each must be a
 * `WriteButton` / `WriteLink`, or appear in the explicit, reviewed EXEMPT list below with a reason. A NEW ungated
 * control therefore fails CI instead of silently shipping enabled in read-only.
 *
 * Menu items given as data (`label: "Mark cleared"`) are checked the same way: the item object must read the gate
 * (`readOnly`) within its own few lines.
 */
const WEB = path.resolve(__dirname, "..");
const LABEL =
  /Record Payment|Create (Order|Invoice|Estimate)|New (Order|Invoice|Estimate|sale)|Mark (cleared|bounced)/i;
/** Elements that are controls (headings, paragraphs and spans that merely mention a label are not). */
const CONTROL_TAGS = new Set(["Button", "button", "Link", "a", "WriteButton", "WriteLink"]);
const GATED_TAGS = new Set(["WriteButton", "WriteLink"]);

/** file (posix, from apps/web) -> the exact label texts reviewed as intentionally NOT gated, with why. */
const EXEMPT: Record<string, { labels: string[]; why: string }> = {
  "app/(dashboard)/invoices/[id]/page.tsx": {
    labels: ["Mark Bounced", "Record Payment"],
    why: "(1) the mark-bounced and record-payment MODALS' own submits: they open only from gated triggers and the server refuses the write; (2) the read-only twin of the Record Payment trigger, a deliberately disabled button",
  },
  "app/(dashboard)/bookkeeping/[transactionId]/page.tsx": {
    labels: ["Record Payment"],
    why: "the record-payment MODAL's own submit: it opens only from the gated triggers in this file; the server refuses the write",
  },
  "app/(dashboard)/vendor-bills/[id]/page.tsx": {
    labels: ["Record Payment"],
    why: "the record-payment MODAL's own submit: it opens only from the gated triggers in this file; the server refuses the write",
  },
  "app/(dashboard)/estimates/page.tsx": {
    labels: ["Create Estimate"],
    why: "the new-estimate MODAL's own submit: it opens only from the gated New Estimate triggers; the server refuses the write",
  },
  "components/RecordSupplierPaymentModal.tsx": {
    labels: ["Record Payment"],
    why: "the supplier payment MODAL's own submit: mounted only from the gated Record payment trigger; the server refuses the write",
  },
  "app/(dashboard)/orders/_components/CounterSaleScreen.tsx": {
    labels: ["Discard and start a new sale"],
    why: "a local reset of a corrupt held cart: it writes nothing; the next sale's Charge is itself gated",
  },
  "app/buyer/portal/[seller]/cart/page.tsx": {
    labels: ["Create new order instead"],
    why: "buyer side, a local toggle (forceNew); the buyer's Place Order is disabled while the seller is read-only and the seller guard refuses the write",
  },
  "components/DraftDock.tsx": {
    labels: ["Start a new order instead"],
    why: "navigates to the new-order builder, whose Create Order / Save as Draft are gated; it writes nothing itself",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "e2e") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(WEB, f).split(path.sep).join("/");

interface Hit {
  file: string;
  label: string;
  tag: string;
  line: number;
}

function scan(): { jsx: Hit[]; data: Hit[] } {
  const jsx: Hit[] = [];
  const data: Hit[] = [];
  for (const f of [...walk(path.join(WEB, "app")), ...walk(path.join(WEB, "components"))]) {
    const text = fs.readFileSync(f, "utf8");
    // JSX text directly inside a control: >  label  </Tag>
    const re = />\s*([^<>{}\n][^<>{}]{0,60}?)\s*<\/(\w+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const label = m[1].trim();
      if (!LABEL.test(label) || !CONTROL_TAGS.has(m[2])) continue;
      jsx.push({
        file: rel(f),
        label,
        tag: m[2],
        line: text.slice(0, m.index).split("\n").length,
      });
    }
    // menu items as data: label: "Mark cleared"
    const dre = /label:\s*"([^"]{1,40})"/g;
    while ((m = dre.exec(text))) {
      if (!LABEL.test(m[1])) continue;
      const after = text
        .slice(m.index, m.index + 400)
        .split("\n")
        .slice(0, 8)
        .join("\n");
      if (/readOnly/.test(after)) continue;
      data.push({
        file: rel(f),
        label: m[1],
        tag: "item",
        line: text.slice(0, m.index).split("\n").length,
      });
    }
  }
  return { jsx, data };
}

describe("read-only gate inventory (B4)", () => {
  const { jsx, data } = scan();

  it("finds the controls (the scan is not vacuous)", () => {
    expect(jsx.filter((h) => GATED_TAGS.has(h.tag)).length).toBeGreaterThanOrEqual(20);
  });

  it("every create / record-payment control is a WriteButton / WriteLink, or a reviewed exemption", () => {
    const ungated = jsx
      .filter((h) => !GATED_TAGS.has(h.tag))
      .filter((h) => !(EXEMPT[h.file]?.labels ?? []).includes(h.label))
      .map((h) => `${h.file}:${h.line} <${h.tag}> "${h.label}"`);
    expect(ungated).toEqual([]);
  });

  it("every menu item that records or clears a payment reads the gate", () => {
    expect(data.map((h) => `${h.file}:${h.line} item "${h.label}"`)).toEqual([]);
  });

  it("every exemption is still in use (a stale entry must be deleted)", () => {
    for (const [file, ex] of Object.entries(EXEMPT)) {
      for (const label of ex.labels) {
        expect(
          jsx.some((h) => h.file === file && h.label === label && !GATED_TAGS.has(h.tag)),
        ).toBe(true);
      }
      expect(ex.why.length).toBeGreaterThan(20);
    }
  });
});
