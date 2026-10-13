#!/usr/bin/env node
// SA-733 D7 — the October CATCH-UP tool for manually invoiced tenants.
//
// DRY-RUN IS THE DEFAULT. It reads, prints, and writes nothing: per tenant the resolved monthly price (override
// beats catalog), the catch-up line ("Subscription — October 2026" and what it comes to, add-ons included), the
// RfInvoice state (open / paid counts), the subscription census (a Stripe subscription already stored? manual
// invoicing? a held claim?) and the Checkout shape. Output is tenant ids, counts and amounts: never a name or a
// slug.
//
//   API_URL=https://<api>/api/v1 SUPER_ADMIN_USERNAME=... SUPER_ADMIN_PASSWORD=... \
//     node apps/api/scripts/billing-catchup.mjs --tenant <slug>          # dry-run of one tenant
//     node apps/api/scripts/billing-catchup.mjs --all                    # dry-run census (ids/counts only)
//     node apps/api/scripts/billing-catchup.mjs --tenant <slug> --apply --backup-taken [--live-tenant-override]
//
// --apply creates ONE Checkout session for ONE tenant and prints its URL (the customer pays it; nothing is
// charged by this tool). It needs ALL of: --tenant <slug> (never --all), an ELIGIBLE dry-run, --backup-taken, a
// real terminal on stdin+stdout, the slug typed back, and for a non-test tenant --live-tenant-override plus the
// protected-tenant guard (#3344) - which FAILS CLOSED while absent (see lib/billing-catchup-core.cjs). The amount
// the dry-run printed is sent with the request: if the server's fresh plan differs, nothing is created.
//
// The server (platform-admin catchup routes) owns every number; this script never prices anything. A Stripe
// shape that Checkout rejects comes back as NEEDS RULING and is never worked around.
//
// Exit: 0 dry-run printed / session created · 1 refused (nothing sent) · 2 environment / connection error.
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveApiBase, loginAsSuperAdmin, findTenantBySlug } from "./lib/platform-admin-http.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const core = require("./lib/billing-catchup-core.cjs");

async function api(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      `${method} ${path} → ${res.status}: ${json?.message ?? text ?? res.statusText}`,
    );
    err.status = res.status;
    err.code = json?.code ?? json?.message?.code ?? null;
    throw err;
  }
  return json;
}

function askLine(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(q, (a) => {
      rl.close();
      r(a);
    }),
  );
}

async function main(argv) {
  const parsed = core.parseArgs(argv);
  if (!parsed.ok) {
    console.error(`billing-catchup: ${parsed.error}`);
    return 1;
  }
  const { args } = parsed;
  if (args.help) {
    console.log(
      "usage: billing-catchup.mjs (--tenant <slug> | --all) [--apply --backup-taken [--live-tenant-override] [--expected-cents N]] [--json]",
    );
    return 0;
  }
  if (args.api) process.env.API_URL = args.api;

  let base;
  let token;
  try {
    base = resolveApiBase();
    token = await loginAsSuperAdmin(base);
  } catch (e) {
    console.error(`billing-catchup: ${e.message}`);
    return 2;
  }

  if (args.all) {
    const census = await api(base, "GET", "/platform-admin/billing/catchup-census", { token });
    console.log(args.json ? JSON.stringify(census, null, 2) : core.formatCensus(census).join("\n"));
    console.log("\nDRY-RUN: nothing was created.");
    return 0;
  }

  let tenant;
  try {
    tenant = await findTenantBySlug(base, token, args.tenant);
  } catch (e) {
    console.error(`billing-catchup: ${e.message}`);
    return 1;
  }
  const report = await api(
    base,
    "GET",
    `/platform-admin/tenants/${tenant.id}/billing/catchup-plan`,
    {
      token,
    },
  );
  console.log(
    args.json ? JSON.stringify(report, null, 2) : core.formatTenantReport(report).join("\n"),
  );

  if (!args.apply) {
    console.log(
      "\nDRY-RUN: nothing was created. To create the checkout: re-run with --apply --backup-taken.",
    );
    return 0;
  }

  const guard = core.loadProtectedGuard(resolve(HERE, "lib"));
  const gate = await core.applyGate({
    args,
    report,
    stdin: process.stdin,
    stdout: process.stdout,
    ask: askLine,
    guard,
    env: process.env,
    argv,
  });
  if (!gate.ok) {
    console.error(`\nbilling-catchup: REFUSED: ${gate.why}. Nothing was created.`);
    return 1;
  }

  const expected = args.expectedCents ?? (report.plan.ok ? report.plan.stub.totalCents : undefined);
  if (expected == null) {
    console.error("billing-catchup: REFUSED: no dry-run amount to pin. Nothing was created.");
    return 1;
  }
  try {
    const out = await api(
      base,
      "POST",
      `/platform-admin/tenants/${tenant.id}/billing/catchup-checkout`,
      {
        token,
        body: { expectedStubCents: expected },
      },
    );
    console.log(
      `\nCreated checkout ${out.sessionId} (shape ${out.shape}, catch-up ${core.money(out.stubCents)}).\nSend the customer: ${out.checkoutUrl}`,
    );
    return 0;
  } catch (e) {
    console.error(
      `\nbilling-catchup: the server refused: ${e.message}${e.code ? ` [${e.code}]` : ""}`,
    );
    return e.status && e.status < 500 ? 1 : 2;
  }
}

// process.exitCode, not process.exit(): on Windows an immediate exit right after fetch() trips a libuv assertion
// (exit 127) - letting the loop drain returns the real code.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`billing-catchup: ${e.message}`);
    process.exitCode = 2;
  },
);
