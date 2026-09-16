#!/usr/bin/env node
/**
 * check-email-sender.mjs — read-only platform email diagnostic (B449).
 *
 * Prints which platform email transport is resolved from the current environment
 * (mirrors EmailService's own constructor precedence: platform SMTP wins over
 * Resend, and neither means platform email is unconfigured) and the sender
 * address that would be used, then does a REAL handshake to prove the credentials
 * work — WITHOUT sending any mail:
 *   - SMTP:   nodemailer transport.verify() (connects + authenticates, no send)
 *   - Resend: a lightweight authenticated API call (domains.list) to confirm the
 *             key is accepted, again with no send
 *
 * Usage (against prod):
 *   railway run --service api node apps/api/scripts/check-email-sender.mjs
 * Usage (local):
 *   node apps/api/scripts/check-email-sender.mjs
 *
 * Exit codes: 0 = handshake ok (or nothing configured — that's a valid, reported
 * state, not an error); 1 = a transport is configured but the handshake failed.
 */
import nodemailer from "nodemailer";

const env = process.env;

function resolveProvider() {
  if (env.SMTP_HOST) {
    return {
      provider: "smtp",
      config: {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? 587),
        secure: env.SMTP_SECURE === "true",
        user: env.SMTP_USER ?? "",
        pass: env.SMTP_PASS ?? "",
      },
    };
  }
  if (env.RESEND_API_KEY) {
    return { provider: "resend", config: { apiKey: env.RESEND_API_KEY } };
  }
  return { provider: "none", config: null };
}

function redact(secret) {
  if (!secret) return "(not set)";
  if (secret.length <= 4) return "****";
  return `${secret.slice(0, 2)}${"*".repeat(Math.max(secret.length - 4, 4))}${secret.slice(-2)}`;
}

async function main() {
  const { provider, config } = resolveProvider();
  const emailFrom =
    env.EMAIL_FROM ??
    "RouteFlow <invoices@send.routeflow.info> (built-in default — EMAIL_FROM not set)";

  console.log("── RouteFlow platform email — resolved configuration ──");
  console.log(`Provider : ${provider}`);
  console.log(`Sender   : ${emailFrom}`);

  if (provider === "smtp") {
    console.log(`SMTP host: ${config.host}:${config.port} (secure=${config.secure})`);
    console.log(`SMTP user: ${config.user || "(not set)"}`);
    console.log(`SMTP pass: ${redact(config.pass)}`);
  } else if (provider === "resend") {
    console.log(`Resend key: ${redact(config.apiKey)}`);
  } else {
    console.log("Nothing configured — SMTP_HOST and RESEND_API_KEY are both unset.");
    console.log(
      "Platform email is DISABLED; only a tenant's own SMTP (Settings → Email) can send.",
    );
    process.exitCode = 0;
    return;
  }

  console.log("\n── Handshake (no email is sent) ──");

  if (provider === "smtp") {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.port === 587 && !config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      dnsTimeout: 10_000,
    });
    try {
      await transport.verify();
      console.log("OK — connected and authenticated. Platform SMTP is ready to send.");
      process.exitCode = 0;
    } catch (err) {
      console.error(`FAILED — ${err?.message ?? err}`);
      if (err?.code) console.error(`  code: ${err.code}`);
      if (err?.responseCode) console.error(`  responseCode: ${err.responseCode}`);
      console.error(
        "  Common Gmail causes: normal password instead of an App Password " +
          "(myaccount.google.com/apppasswords), or 2-Step Verification not yet enabled " +
          "on the mailbox — see docs/runbooks/transactional-email-setup.md.",
      );
      process.exitCode = 1;
    }
    return;
  }

  // Resend: no verify() equivalent — a lightweight authenticated read confirms
  // the key is valid without sending anything.
  const { Resend } = await import("resend");
  const resend = new Resend(config.apiKey);
  try {
    const res = await resend.domains.list();
    if (res?.error) {
      console.error(
        `FAILED — Resend rejected the API key: ${res.error?.message ?? "unknown error"}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("OK — Resend accepted the API key.");
    process.exitCode = 0;
  } catch (err) {
    console.error(`FAILED — ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

main();
