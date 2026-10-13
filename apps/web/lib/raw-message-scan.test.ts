import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rawMessageReads, scanTree } from "./raw-message-scan";
import ALLOWLIST from "./raw-message-allowlist.json";

/**
 * B986 static pin: no non-test source under apps/web reads a server / axios message outside the closed allowlist
 * `raw-message-allowlist.json`. A RATCHET: each file's count must EQUAL its entry (a new read anywhere fails, and removing a
 * read without lowering the entry fails too). The PENDING total is an exact number, never a ceiling, and the PERMANENT
 * entries are pinned exactly (file + count): an area PR that removes reads edits this file and the JSON in the same diff.
 */
const WEB = path.resolve(__dirname, "..");

type Entry = { count: number; why: string; permanent?: boolean };
const allow = ALLOWLIST as Record<string, Entry>;

/** Reads that are lookups, classifications or logs and never render the text. Pinned EXACTLY (file -> count). */
const PERMANENT_EXPECTED: Record<string, number> = {
  "app/(dashboard)/orders/_components/scan/useScanCodeHandler.ts": 2,
  "components/ScanInvoiceModal.tsx": 1,
  "lib/buyer-auth-context.tsx": 2,
  "lib/credit-note-error-copy.ts": 1,
  "lib/customer-form-error-copy.ts": 1,
  "lib/e2e-setup-guard.ts": 2,
  "lib/generic-toast-copy.ts": 1,
  "lib/hooks/useRealtimeUpdates.ts": 1,
  "lib/product-reactivation-refusal.ts": 1,
  "lib/reason-copy.ts": 1,
};
/** The exact pending total (reads still to be converted by the B986 area PRs). */
const PENDING_TOTAL = 227;

describe("no raw server message in apps/web UI (B986 ratchet)", () => {
  const found = scanTree(WEB);

  it("every file with a raw message read is allowlisted at its exact count", () => {
    const bad: string[] = [];
    for (const [f, n] of Object.entries(found)) {
      if (!allow[f]) bad.push(`${f}: ${n} raw message read(s), not allowlisted`);
      else if (allow[f].count !== n)
        bad.push(`${f}: ${n} read(s) but the allowlist says ${allow[f].count}`);
    }
    for (const f of Object.keys(allow))
      if (!found[f]) bad.push(`${f}: allowlisted but has no raw message read (delete the entry)`);
    expect(bad).toEqual([]);
  });

  it("the PERMANENT entries are exactly the expected files and counts, each with a reason", () => {
    const perm = Object.fromEntries(
      Object.entries(allow)
        .filter(([, e]) => e.permanent)
        .map(([f, e]) => [f, e.count]),
    );
    expect(perm).toEqual(PERMANENT_EXPECTED);
    for (const e of Object.values(allow)) expect(e.why.length).toBeGreaterThan(8);
  });

  it("the PENDING total is exact", () => {
    const pending = Object.values(allow)
      .filter((e) => !e.permanent)
      .reduce((a, e) => a + e.count, 0);
    expect(pending).toBe(PENDING_TOTAL);
  });
});

/**
 * WALKER-level proof: real FILE fixtures in a temp tree, one per bypass form, run through the same `scanTree` the ratchet uses.
 * A form the scanner stops catching turns its fixture red.
 */
describe("scanTree catches every bypass form (file fixtures)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rf-b986-scan-"));
  const write = (name: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  };

  const MUST_CATCH: Record<string, string> = {
    "a/response-data.ts": "toast({ title: err?.response?.data?.message });",
    "a/alias-err.ts": "const m = err.message;",
    "a/alias-e.ts": "const m = e?.message ?? 'x';",
    "a/cast.ts": "const m = (err as Error).message;",
    "a/cast-any.ts": "const m = (e as any)?.message;",
    "a/cast-object.ts": "const m = (err as { message?: string })?.message;",
    "a/bracket.ts": 'const m = err["message"]; const n = data?.["message"];',
    "a/bracket-single.ts": "const m = body['message'];",
    "a/destructure.tsx": "const { message } = err;",
    "a/destructure-rename.ts": "const { message: msg } = error;",
    "a/destructure-nested.ts": "const { data: { message } } = err.response;",
    "a/payload-alias.ts": "const p = r.response.data; toast(payload.message);",
    "a/body-alias.ts": "setError(body.message);",
    "a/res-alias.ts": "setError(res.data.message);",
    "a/after-slashes-in-string.ts": 'const u = "https://x.test/a//b"; const m = err.message;',
    "a/after-slashes-in-single.ts": "const u = 'a//b'; const m = e.message;",
    "a/template.tsx": "const t = `Failed: ${err.message}`;",
    "a/template-nested.tsx": "const t = `a ${cond ? `b ${e.message}` : ''}`;",
    "a/jsx.tsx": "const x = <p>{err.message}</p>;",
    // The two JSX holes the string-masking scanner had: an apostrophe in JSX TEXT, and `/>` after a quoted attribute.
    "a/jsx-apostrophe.tsx": "const x = <p>Don't show {err.message}</p>;",
    "a/jsx-apostrophe-after.tsx": "const x = <p>It's {err.message} and it's {e.message}</p>;",
    "a/jsx-selfclose.tsx": 'const x = <><input value="a" />{err.message}</>;',
    "a/jsx-attr-expr.tsx": 'const x = <Alert title="oops" description={body.message} />;',
    "a/gate-receiver.tsx": "const x = <p>{gate.message}</p>;",
  };
  const MUST_IGNORE: Record<string, string> = {
    "b/line-comment.ts": "// err.message is never shown\nconst x = 1;",
    "b/block-comment.ts": "/* e.message and response.data.message */ const x = 1;",
    "b/in-string.ts": "const s = 'err.message'; const t = \"data.message\";",
    "b/in-template-text.ts": "const s = `the text err.message here`;",
    "b/regex.ts": "const re = /err.message/; const ok = 1;",
    "b/other-receiver.ts": "const x = thing.message; const y = form.message;",
    "b/test-file.test.ts": "const m = err.message;",
  };
  beforeAll(() => {
    for (const [f, b] of Object.entries({ ...MUST_CATCH, ...MUST_IGNORE })) write(f, b);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each(Object.keys(MUST_CATCH))("catches %s", (f) => {
    expect(scanTree(root)[f]).toBeGreaterThanOrEqual(1);
  });

  it.each(Object.keys(MUST_IGNORE))("ignores %s", (f) => {
    expect(scanTree(root)[f]).toBeUndefined();
  });

  it("counts a read once even when two forms match it, and every read on a line", () => {
    expect(rawMessageReads("const a = err?.response?.data?.message ?? err.message;")).toHaveLength(
      2,
    );
    expect(rawMessageReads("x = (err as Error).message")).toHaveLength(1);
  });

  it("a JSX apostrophe or a self-closing tag no longer blanks the rest of the line", () => {
    expect(rawMessageReads("const x = <p>Don't {err.message}</p>;")).toHaveLength(1);
    expect(rawMessageReads('const x = <><input value="a" />{err.message}</>;')).toHaveLength(1);
  });

  it(".ts mode parses type assertions and generics", () => {
    expect(
      rawMessageReads("const m = (<Error>err).message; const f = <T,>(x: T) => x;", "ts"),
    ).toHaveLength(1);
  });
});
