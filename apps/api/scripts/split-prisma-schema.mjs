#!/usr/bin/env node
/**
 * split-prisma-schema.mjs — the committed, repeatable operation behind the
 * `prisma/schema.prisma` → `prisma/schema/` multi-file split (improvements item 10a).
 *
 * Prisma 7 supports a *schema folder*: every `*.prisma` file under the configured
 * `schema` directory is concatenated into one datamodel. Splitting is therefore a
 * pure text move — it must not add, drop or reword a single top-level block.
 *
 * Modes
 *   --write --from <file> | --from-ref <git-ref>
 *                             Split a single-file schema into prisma/schema/*.prisma. The
 *                             source is read from the given --from path, or from that
 *                             --from-ref's copy of apps/api/prisma/schema.prisma via
 *                             `git show <ref>:apps/api/prisma/schema.prisma`. While
 *                             prisma/schema.prisma still exists on disk, neither flag is
 *                             required — it is read directly — but once the single file is
 *                             gone (the normal state after this split has landed), --write
 *                             requires one of --from/--from-ref and says so if omitted.
 *                             Deterministic: re-running `--write --from-ref <ref>` reproduces
 *                             byte-identical output for a ref whose model set matches the
 *                             folder's. `e39bf9db` is NOT such a ref any more — the folder has
 *                             legitimately gained models since the split, so re-splitting that
 *                             blob no longer reproduces what is checked in today.
 *   --check [--from <file> | --from-ref <git-ref>]
 *                             ALWAYS verifies the folder's structural invariants, with no
 *                             original file needed: the 7-file set, `_base` holds exactly
 *                             one datasource + one generator and no model/enum, every other
 *                             domain file holds at least one model, every model/enum name is
 *                             unique repo-wide, every model sits in the file MODEL_DOMAIN
 *                             names for it (and MODEL_DOMAIN names no model the folder lacks),
 *                             and every enum sits in a domain file that itself holds a model
 *                             referencing it as a field type (an enum no model anywhere
 *                             references must sit in _base). That last check is membership,
 *                             not strict original ordering: which referencing model came
 *                             FIRST in the pre-split single file is not reconstructable from
 *                             domain grouping alone (domains interleave in the original file
 *                             in ways a split does not preserve) — the strict, order-accurate
 *                             proof is exactly what --from/--from-ref's block comparison below
 *                             gives you. When --from or --from-ref
 *                             is ALSO given, it additionally re-derives the concatenation and
 *                             compares the whitespace-normalized multiset of top-level blocks
 *                             against that original, printing "block-identical (N blocks)" on
 *                             success or a non-zero exit listing every differing block.
 *                             Without one of those flags it prints a distinct line instead —
 *                             never the word "block-identical" — because the original
 *                             lossless proof was recorded once, at split time, against
 *                             e39bf9db (207 blocks; see docs/IMPROVEMENTS.md item 10), and is
 *                             not re-derived on every run. --from/--from-ref is therefore only
 *                             meaningful for a ref whose model set matches the folder's, and
 *                             e39bf9db no longer does — `--check --from-ref e39bf9db` now FAILS
 *                             on block count 208 vs 207, so do not run it expecting green. The
 *                             standing lossless guard going forward is the drift gate
 *                             (apps/api/scripts/schema-drift.mjs / `npm run local:drift`).
 *   --print-map               Dump the model → file map as TSV and exit.
 *
 * Losslessness is defined on *blocks*, not bytes: parseBlocks() treats a block as the text
 * from the end of the previous block's closing brace up to and including its own closing
 * brace, so nothing between blocks is ever silently dropped at parse time. But the
 * `--from`/`--from-ref` block-identity COMPARISON is narrower on purpose: it normalizes
 * each block (blockIdentityText()) down to its body plus a genuinely ATTACHED `///` doc
 * comment (a contiguous run of `///` lines directly above the block, no blank line in
 * between) and drops everything else in that leading span — blank lines and any `//`
 * section banner (e.g. `// ─── Enums ───`), which sits separated from the declaration by
 * a blank line. That is what lets a purely cosmetic banner reword (domain-scoping a
 * generic "Enums"/"Models" header, or dropping a stale "Sprint N:" prefix) keep reporting
 * block-identical: the banner text was never part of any block's identity to begin with.
 *
 * The name → domain map below is explicit on purpose. An unmapped model is a hard
 * error — there is deliberately no "misc" bucket, so adding a model forces a decision.
 * Enums are placed automatically: an enum lives beside the FIRST model (in original
 * file order) that uses it as a field type; an enum no model references lands in _base.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(API_DIR, "..", "..");
const SINGLE_FILE = path.join(API_DIR, "prisma", "schema.prisma");
const SCHEMA_DIR = path.join(API_DIR, "prisma", "schema");
const SINGLE_FILE_REPO_REL = "apps/api/prisma/schema.prisma";

const DOMAINS = [
  ["_base", "datasource + generator only — no models, no enums unless unreferenced"],
  ["tenancy", "tenants, users, staff + buyer identity, auth tokens, platform-admin config"],
  [
    "catalog",
    "products, suppliers, stock/lots/movements, counts, purchase orders, product matching",
  ],
  [
    "sales",
    "customers, orders, order templates, routes, drivers, returns, promotions, sales agents",
  ],
  [
    "finance",
    "AR/AP — transactions, invoices, credit notes, vendor bills, estimates, expenses, payments",
  ],
  [
    "platform",
    "SaaS billing/plans, messaging, audit, import/migration, config, AI usage, numbering",
  ],
  ["compliance", "regulated / tracked categories, tobacco, customer authorizations, filings"],
];
const DOMAIN_NAMES = DOMAINS.map(([n]) => n);
const DOMAIN_BLURB = Object.fromEntries(DOMAINS);

/** Explicit model → domain map. Every model in the schema MUST appear here. */
const MODEL_DOMAIN = {
  // ─── tenancy ───────────────────────────────────────────────────────────────
  Tenant: "tenancy",
  TenantConfig: "tenancy",
  TenantGoogleOAuth: "tenancy",
  User: "tenancy",
  UserPreference: "tenancy",
  RefreshToken: "tenancy",
  PasswordResetToken: "tenancy",
  DeviceToken: "tenancy",
  PlatformConfig: "tenancy",
  BuyerAccount: "tenancy",
  BuyerRefreshToken: "tenancy",
  BuyerPasswordResetToken: "tenancy",
  BuyerEmailVerificationToken: "tenancy",
  CustomerLink: "tenancy",
  BuyerMergeRequest: "tenancy",

  // ─── catalog ───────────────────────────────────────────────────────────────
  Product: "catalog",
  Supplier: "catalog",
  StockLot: "catalog",
  StockMovement: "catalog",
  ProductMapping: "catalog",
  ProductAlias: "catalog",
  StockAlert: "catalog",
  StockCountSession: "catalog",
  StockCountLine: "catalog",
  PurchaseOrder: "catalog",
  PurchaseOrderItem: "catalog",

  // ─── sales ─────────────────────────────────────────────────────────────────
  Customer: "sales",
  CustomerDocument: "sales",
  CustomerAddress: "sales",
  CustomerTag: "sales",
  CustomerTagAssignment: "sales",
  CustomerComment: "sales",
  ContactPerson: "sales",
  CustomerPrice: "sales",
  Driver: "sales",
  DriverLocation: "sales",
  Route: "sales",
  RouteStop: "sales",
  RouteCustomer: "sales",
  RouteRun: "sales",
  RouteRunStop: "sales",
  Order: "sales",
  OrderIdempotencyKey: "sales",
  OrderRevision: "sales",
  ChangeRequest: "sales",
  OrderItem: "sales",
  DeliveryMutation: "sales",
  DeliveryBatch: "sales",
  OrderTemplate: "sales",
  OrderTemplateItem: "sales",
  Return: "sales",
  ReturnItem: "sales",
  Promotion: "sales",
  PromotionProduct: "sales",
  BuyerFavorite: "sales",
  ReplenishmentSnooze: "sales",
  SaleDraft: "sales",
  SalesAgent: "sales",
  SalesAgentRate: "sales",
  CustomerCommissionRate: "sales",
  AgentAssignment: "sales",
  CommissionAccrual: "sales",
  CommissionAdjustment: "sales",
  CommissionStatement: "sales",
  CommissionStatementLine: "sales",
  CommissionPayout: "sales",

  // ─── finance ───────────────────────────────────────────────────────────────
  Transaction: "finance",
  TransactionItem: "finance",
  Payment: "finance",
  Invoice: "finance",
  InvoiceItem: "finance",
  InvoicePayment: "finance",
  PaymentCounter: "finance",
  ExpenseCategory: "finance",
  Expense: "finance",
  ExpenseLineItem: "finance",
  MileageRate: "finance",
  CreditNote: "finance",
  CreditNoteItem: "finance",
  OrderCreditNote: "finance",
  Estimate: "finance",
  EstimateItem: "finance",
  VendorBill: "finance",
  VendorBillItem: "finance",
  BillPayment: "finance",
  InvoiceScan: "finance",
  SupplierStatementScan: "finance",
  AdvancePayment: "finance",
  SupplierCredit: "finance",
  RecurringInvoice: "finance",
  RecurringInvoiceItem: "finance",
  TenantStripeConnect: "finance",
  StripeConnectEvent: "finance",
  BuyerPaymentRequest: "finance",

  // ─── platform ──────────────────────────────────────────────────────────────
  TenantSubscription: "platform",
  BillingNotificationLog: "platform",
  TenantAddon: "platform",
  PlanVersion: "platform",
  PlanDefinition: "platform",
  AddonSku: "platform",
  MeterUsage: "platform",
  BillingEvent: "platform",
  RfInvoice: "platform",
  SystemConfig: "platform",
  Message: "platform",
  MessageThread: "platform",
  MessageTemplate: "platform",
  NotificationRule: "platform",
  MessageOptOut: "platform",
  MessagingSettings: "platform",
  InboundTriage: "platform",
  AuditLog: "platform",
  NumberingSequence: "platform",
  ImportExternalRef: "platform",
  MigrationJob: "platform",
  MigrationStagingRecord: "platform",
  ImportBatch: "platform",
  ImportQueueItem: "platform",
  AiUsageEvent: "platform",
  IdempotencyKey: "platform",
  DemoBooking: "platform",
  CrmConnection: "platform",
  CrmHandoff: "platform",

  // ─── compliance ────────────────────────────────────────────────────────────
  TobaccoReport: "compliance",
  TrackedCategory: "compliance",
  TrackedSubcategory: "compliance",
  CustomerAuthorization: "compliance",
  AuthorizationOverride: "compliance",
  RegulatedSalesLedger: "compliance",
  RegulatedFiling: "compliance",
};

const HEADER_RE =
  /^\/\/ (?:RouteFlow Prisma schema — domain file: |Generated by apps\/api\/scripts\/split-prisma-schema\.mjs)/;

function header(domain) {
  return (
    `// RouteFlow Prisma schema — domain file: ${domain} (${DOMAIN_BLURB[domain]}).\n` +
    `// Generated by apps/api/scripts/split-prisma-schema.mjs — run it with --check to prove the split is lossless.\n\n`
  );
}

function die(msg) {
  console.error(`ERROR  ${msg}`);
  process.exit(1);
}

const BLOCK_HEAD_RE = /^(datasource|generator|model|enum|type|view) ([A-Za-z_][A-Za-z0-9_]*) \{$/;

/**
 * Parse a Prisma schema text into ordered top-level blocks. Each block's `text` runs
 * from just after the previous block's closing brace to its own closing brace, so the
 * preceding comments/blank lines travel with it and no character is dropped.
 */
function parseBlocks(text, label) {
  const src = text.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const blocks = [];
  let chunkStart = 0; // line index where the current block's leading comment run begins
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open === null) {
      const m = BLOCK_HEAD_RE.exec(line);
      if (m) open = { kind: m[1], name: m[2], headLine: i };
      else if (/^[^\s/}]/.test(line))
        die(
          `${label}: line ${i + 1} starts a top-level construct this parser does not understand: ${line}`,
        );
      continue;
    }
    if (line === "}") {
      blocks.push({
        kind: open.kind,
        name: open.name,
        text: lines
          .slice(chunkStart, i + 1)
          .join("\n")
          .replace(/[ \t]+$/gm, "")
          .trim(),
        body: lines.slice(open.headLine, i + 1).join("\n"),
      });
      open = null;
      chunkStart = i + 1;
    }
  }
  if (open) die(`${label}: unterminated ${open.kind} ${open.name}`);
  const tail = lines.slice(chunkStart).join("\n").trim();
  if (tail)
    die(
      `${label}: ${tail.length} characters of trailing text after the last block would be lost:\n${tail}`,
    );
  return blocks;
}

/** Field-type tokens used inside a block body (comments stripped). */
function typeTokens(body) {
  const out = new Set();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    const m = /^\s{2,}[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Assign every block a domain file. Returns Map<blockIndex, domain>. */
function assignDomains(blocks) {
  const assignment = new Map();
  const modelNames = blocks.filter((b) => b.kind === "model").map((b) => b.name);
  const unmapped = modelNames.filter((n) => !MODEL_DOMAIN[n]);
  if (unmapped.length)
    die(
      `${unmapped.length} model(s) are not in MODEL_DOMAIN — add them to the map in this script ` +
        `(there is no "misc" bucket on purpose):\n  ${unmapped.join("\n  ")}`,
    );
  const stale = Object.keys(MODEL_DOMAIN).filter((n) => !modelNames.includes(n));
  if (stale.length)
    die(
      `MODEL_DOMAIN names ${stale.length} model(s) the schema no longer has: ${stale.join(", ")}`,
    );

  const enumNames = new Set(blocks.filter((b) => b.kind === "enum").map((b) => b.name));
  const enumOwner = new Map();
  for (const b of blocks) {
    if (b.kind !== "model") continue;
    for (const t of typeTokens(b.body)) {
      if (enumNames.has(t) && !enumOwner.has(t)) enumOwner.set(t, MODEL_DOMAIN[b.name]);
    }
  }
  blocks.forEach((b, i) => {
    if (b.kind === "datasource" || b.kind === "generator") assignment.set(i, "_base");
    else if (b.kind === "model") assignment.set(i, MODEL_DOMAIN[b.name]);
    else if (b.kind === "enum") assignment.set(i, enumOwner.get(b.name) ?? "_base");
    else
      die(
        `unsupported top-level block kind "${b.kind} ${b.name}" — extend this script before splitting it`,
      );
  });
  return { assignment, enumOwner, enumNames };
}

function renderFiles(blocks, assignment) {
  const files = new Map(DOMAIN_NAMES.map((d) => [d, []]));
  blocks.forEach((b, i) => files.get(assignment.get(i)).push(b.text));
  const out = new Map();
  for (const d of DOMAIN_NAMES) out.set(d, header(d) + files.get(d).join("\n\n") + "\n");
  return out;
}

/**
 * Read the original single-file schema — but ONLY when explicitly named: --from <path>
 * or --from-ref <git-ref>. There is deliberately no implicit fallback (no "read
 * prisma/schema.prisma if it happens to exist", no "git show HEAD:..."): the caller
 * decides whether an original is in play, and --check treats "no original" as a valid,
 * fully-structural mode rather than silently reaching for one.
 */
function readOriginal(fromArg, fromRefArg) {
  if (fromArg) {
    const p = path.resolve(process.cwd(), fromArg);
    if (!fs.existsSync(p)) die(`--from ${fromArg} does not exist`);
    return { text: fs.readFileSync(p, "utf8"), label: fromArg };
  }
  if (fromRefArg) {
    const ref = `${fromRefArg}:${SINGLE_FILE_REPO_REL}`;
    try {
      const text = execFileSync("git", ["show", ref], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 32e6,
      });
      return { text, label: `git ${ref}` };
    } catch (e) {
      die(
        `--from-ref ${fromRefArg} — could not read ${SINGLE_FILE_REPO_REL} at that ref (${e.message})`,
      );
    }
  }
  return null;
}

function readFolder() {
  if (!fs.existsSync(SCHEMA_DIR)) die(`schema folder ${SCHEMA_DIR} does not exist`);
  const names = fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".prisma"))
    .sort();
  if (!names.length) die(`schema folder ${SCHEMA_DIR} contains no .prisma files`);
  const per = new Map();
  for (const n of names) {
    const raw = fs.readFileSync(path.join(SCHEMA_DIR, n), "utf8").replace(/\r\n/g, "\n");
    const lines = raw.split("\n");
    while (lines.length && HEADER_RE.test(lines[0])) lines.shift();
    while (lines.length && lines[0].trim() === "") lines.shift();
    per.set(n.replace(/\.prisma$/, ""), parseBlocks(lines.join("\n"), n));
  }
  return per;
}

function tally(blocks) {
  const models = blocks.filter((b) => b.kind === "model").length;
  const enums = blocks.filter((b) => b.kind === "enum").length;
  const other = blocks.length - models - enums;
  return { models, enums, other, blocks: blocks.length };
}

/**
 * The block-identity comparison (--check with --from/--from-ref) deliberately does NOT
 * compare a block's full leading-comment run verbatim — only its body plus a genuinely
 * ATTACHED `///` doc comment. A block's raw `.text` (see parseBlocks) also carries
 * whatever sat between the previous block's `}` and this one, which is often nothing
 * but is sometimes a `// ─── Section Name ───` banner separated from the declaration
 * by a blank line. Renaming a banner (e.g. splitting a domain out of "Enums" into
 * "Enums (tenancy)") is a pure cosmetic move within the split, not a content change,
 * and must not read as a lost/extra block. The rule: walk upward from the block's own
 * head line collecting a CONTIGUOUS run of `///`-prefixed lines (a real attached doc
 * comment, no blank line in the run) — that travels with the block. Anything above
 * that (banner text, blank lines, plain `//` comments) is section furniture and is
 * dropped before comparing.
 */
function blockIdentityText(block) {
  const lines = block.text.split("\n");
  const headIdx = lines.findIndex((l) => BLOCK_HEAD_RE.test(l));
  if (headIdx <= 0) return block.text;
  let start = headIdx;
  for (let j = headIdx - 1; j >= 0 && /^\s*\/\/\//.test(lines[j]); j--) start = j;
  return lines.slice(start).join("\n").trim();
}

function multiset(blocks, textOf = (b) => b.text) {
  const m = new Map();
  for (const b of blocks) {
    const text = textOf(b);
    m.set(text, (m.get(text) ?? 0) + 1);
  }
  return m;
}

function diffMultisets(a, b) {
  const problems = [];
  for (const [text, n] of a) {
    const other = b.get(text) ?? 0;
    if (other !== n)
      problems.push({
        side: other === 0 ? "missing from folder" : "count differs",
        text,
        n,
        other,
      });
  }
  for (const [text, n] of b)
    if (!a.has(text)) problems.push({ side: "extra in folder", text, n, other: 0 });
  return problems;
}

function firstLine(text) {
  const l = text.split("\n").filter((s) => s.trim());
  return l[l.length - 1]?.slice(0, 100) ?? "";
}

// ─── main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv.includes("--write")
  ? "write"
  : argv.includes("--check")
    ? "check"
    : argv.includes("--print-map")
      ? "map"
      : null;
const fromIdx = argv.indexOf("--from");
const fromArg = fromIdx >= 0 ? argv[fromIdx + 1] : null;
const fromRefIdx = argv.indexOf("--from-ref");
const fromRefArg = fromRefIdx >= 0 ? argv[fromRefIdx + 1] : null;
if (!mode)
  die(
    "usage: node apps/api/scripts/split-prisma-schema.mjs (--write | --check | --print-map) [--from <file> | --from-ref <git-ref>]",
  );

if (mode === "map") {
  for (const [m, d] of Object.entries(MODEL_DOMAIN).sort(
    (a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]),
  ))
    console.log(`${d}\t${m}`);
  process.exit(0);
}

if (mode === "write") {
  let original = readOriginal(fromArg, fromRefArg);
  if (!original && fs.existsSync(SINGLE_FILE)) {
    original = { text: fs.readFileSync(SINGLE_FILE, "utf8"), label: "prisma/schema.prisma" };
  }
  if (!original)
    die(
      `--write requires --from <path> or --from-ref <git-ref> now that ${SINGLE_FILE_REPO_REL} no longer exists in the working tree`,
    );
  const blocks = parseBlocks(original.text, original.label);
  const { assignment, enumOwner, enumNames } = assignDomains(blocks);
  const files = renderFiles(blocks, assignment);
  fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const [d, text] of files)
    fs.writeFileSync(path.join(SCHEMA_DIR, `${d}.prisma`), text, "utf8");
  const t = tally(blocks);
  console.log(
    `split ${original.label} → prisma/schema/  (${t.blocks} blocks: ${t.models} models, ${t.enums} enums, ${t.other} other)`,
  );
  for (const d of DOMAIN_NAMES) {
    const own = blocks.filter((_, i) => assignment.get(i) === d);
    const tt = tally(own);
    console.log(
      `  ${d.padEnd(11)} ${String(tt.models).padStart(3)} models  ${String(tt.enums).padStart(3)} enums  ${String(tt.other).padStart(2)} other`,
    );
  }
  const orphan = [...enumNames].filter((e) => !enumOwner.has(e));
  if (orphan.length)
    console.log(
      `  NOTE  ${orphan.length} enum(s) no model references (placed in _base): ${orphan.join(", ")}`,
    );
  console.log(
    `  the single-file schema is NOT deleted by this script — remove it with git rm once --check is green`,
  );
  process.exit(0);
}

// ─── check ────────────────────────────────────────────────────────────────────
// These invariants run unconditionally — no original file is required for any of them.
const per = readFolder();
// Every invariant below is set/count-based, not order-sensitive, so concatenation order
// (alphabetical by filename, matching readFolder()) doesn't affect any verdict.
const folderBlocks = [];
for (const d of [...per.keys()].sort()) folderBlocks.push(...per.get(d));

let failed = false;
const fail = (m) => {
  failed = true;
  console.error(`FAIL   ${m}`);
};

// 1. file set
const got = [...per.keys()].sort().join(",");
const want = [...DOMAIN_NAMES].sort().join(",");
if (got !== want) fail(`schema folder holds [${got}] — expected exactly [${want}]`);

// 2. no duplicate top-level names anywhere (Prisma requires repo-wide uniqueness)
const seen = new Map();
for (const d of per.keys())
  for (const b of per.get(d)) {
    const key = `${b.kind} ${b.name}`;
    if (seen.has(key)) fail(`${key} appears in both ${seen.get(key)}.prisma and ${d}.prisma`);
    else seen.set(key, d);
  }

// 3. _base holds the datasource + generator and no model/enum; every other domain
//    file holds at least one model
const base = per.get("_base") ?? [];
if (!base.some((b) => b.kind === "datasource")) fail("_base.prisma has no datasource block");
if (!base.some((b) => b.kind === "generator")) fail("_base.prisma has no generator block");
if (base.some((b) => b.kind === "model")) fail("_base.prisma must not hold models");
for (const d of DOMAIN_NAMES) {
  if (d === "_base") continue;
  const extra = (per.get(d) ?? []).filter((b) => b.kind === "datasource" || b.kind === "generator");
  if (extra.length)
    fail(`${d}.prisma holds a ${extra[0].kind} block — those belong in _base.prisma`);
  const modelCount = (per.get(d) ?? []).filter((b) => b.kind === "model").length;
  if (modelCount < 1)
    fail(
      `${d}.prisma holds no model blocks — every domain file except _base must hold at least one`,
    );
}

// 4. every model sits in the file the map names, and MODEL_DOMAIN names no model missing
//    from the folder (a stale map entry)
for (const d of per.keys())
  for (const b of per.get(d)) {
    if (b.kind !== "model") continue;
    const want = MODEL_DOMAIN[b.name];
    if (!want) fail(`model ${b.name} is in ${d}.prisma but absent from MODEL_DOMAIN`);
    else if (want !== d)
      fail(`model ${b.name} is in ${d}.prisma but MODEL_DOMAIN says ${want}.prisma`);
  }
const placed = new Set(folderBlocks.filter((b) => b.kind === "model").map((b) => b.name));
for (const n of Object.keys(MODEL_DOMAIN))
  if (!placed.has(n)) fail(`MODEL_DOMAIN names model ${n}, which is in no file`);

// 5. every enum sits in a domain file that itself holds a model referencing it as a
//    field type; an enum no model anywhere references must sit in _base. This is the
//    strongest ALWAYS-checkable proxy for "beside its referencing model" derivable from
//    the folder alone — literally the FIRST referencing model (in the pre-split single
//    file's own physical order) is not reconstructable from domain grouping: models in
//    different domains interleave in the original file in ways a domain split does not
//    preserve. Verified against e39bf9db: PaymentMethod's true first reference is
//    `Payment` (finance) at original line 1637, but a later `CommissionPayout` (sales)
//    reference at line 4420 would be picked "first" by ANY folder-only domain ordering,
//    because "sales" precedes "finance" in every reconstructable order — a false
//    failure on a provably-correct placement. Membership avoids that trap while still
//    catching a genuinely misplaced enum. Run with --from/--from-ref for the strict,
//    original-order-accurate lossless proof instead (step 6 below).
const enumNamesInFolder = new Set(folderBlocks.filter((b) => b.kind === "enum").map((b) => b.name));
const actualEnumFile = new Map();
for (const d of per.keys())
  for (const b of per.get(d)) if (b.kind === "enum") actualEnumFile.set(b.name, d);
const enumReferencedIn = new Map(); // enum name -> Set<domain that holds a referencing model>
for (const b of folderBlocks) {
  if (b.kind !== "model") continue;
  const owningDomain = MODEL_DOMAIN[b.name];
  if (!owningDomain) continue; // unmapped model already failed above
  for (const t of typeTokens(b.body)) {
    if (!enumNamesInFolder.has(t)) continue;
    if (!enumReferencedIn.has(t)) enumReferencedIn.set(t, new Set());
    enumReferencedIn.get(t).add(owningDomain);
  }
}
for (const [enumName, actualFile] of actualEnumFile) {
  const referencingDomains = enumReferencedIn.get(enumName);
  if (!referencingDomains || referencingDomains.size === 0) {
    if (actualFile !== "_base")
      fail(
        `enum ${enumName} is in ${actualFile}.prisma but no model anywhere references it — an unreferenced enum belongs in _base.prisma`,
      );
  } else if (!referencingDomains.has(actualFile)) {
    fail(
      `enum ${enumName} is in ${actualFile}.prisma but no model there references it (referenced only by models in: ${[...referencingDomains].sort().join(", ")})`,
    );
  }
}

// 6. lossless: block multiset equals the original's — ONLY when --from/--from-ref
//    was explicitly given. Without one, this is a fully-structural run: the
//    lossless proof against the pre-split single file was recorded once, at split
//    time, and is not re-derived on every invocation.
const original = readOriginal(fromArg, fromRefArg);
const t = tally(folderBlocks);
if (!original) {
  console.log(
    "OK — structural invariants hold (no original given; lossless proof recorded at split time: " +
      "e39bf9db, 207 blocks, see docs/IMPROVEMENTS.md item 10)",
  );
} else {
  const originalBlocks = parseBlocks(original.text, original.label);
  const ot = tally(originalBlocks);
  const problems = diffMultisets(
    multiset(originalBlocks, blockIdentityText),
    multiset(folderBlocks, blockIdentityText),
  );
  if (ot.blocks !== t.blocks)
    fail(`block count ${t.blocks} in the folder vs ${ot.blocks} in ${original.label}`);
  for (const p of problems.slice(0, 20))
    fail(`${p.side}: ${firstLine(p.text)} (original ${p.n}, folder ${p.other})`);
  if (problems.length > 20) fail(`… and ${problems.length - 20} more block differences`);
  if (!problems.length && ot.blocks === t.blocks)
    console.log(`OK     folder is block-identical (${ot.blocks} blocks) to ${original.label}`);
}

console.log(
  `counts folder: ${t.blocks} blocks — ${t.models} models, ${t.enums} enums, ${t.other} datasource/generator`,
);
for (const d of DOMAIN_NAMES) {
  const tt = tally(per.get(d) ?? []);
  console.log(
    `  ${d.padEnd(11)} ${String(tt.models).padStart(3)} models  ${String(tt.enums).padStart(3)} enums  ${String(tt.other).padStart(2)} other`,
  );
}
if (failed) {
  console.error("split-prisma-schema --check FAILED");
  process.exit(1);
}
console.log("split-prisma-schema --check OK");
