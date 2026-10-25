#!/usr/bin/env node
/**
 * W-830 — fail-closed guard for the hybrid shell's build env (#2653).
 *
 * `lib/web-shell/shell-config.ts` `readShellConfig` returns null (the shell is OFF and every old
 * native screen is back) when EXPO_PUBLIC_WEB_URL is empty, or EXPO_PUBLIC_WEB_SHELL is "off".
 * eas.json sets both on every build profile, but `eas update` (OTA) takes its env from the shell
 * that runs it, so an OTA published without them silently re-ships the old native UI. This script
 * refuses that.
 *
 *   node scripts/assert-shell-env.cjs --ota   # OTA publish: https web URL required
 *   node scripts/assert-shell-env.cjs --eas   # EAS build hook: https, except the development /
 *                                             # preview profiles (EAS_BUILD_PROFILE), which may
 *                                             # use a local / private-LAN http web
 *   node scripts/assert-shell-env.cjs         # strict, same as --ota
 *
 * Exit 0 = ok, 1 = refused (the reasons go to stderr). It reads process.env only: run it with the
 * same env the publish will use. No secret is read or printed; the public web origin is shown.
 *
 * Keep the URL rules in step with lib/web-shell/url-policy.ts `allowedOrigins`;
 * __tests__/web-shell-publish-guard.test.ts pins the two against each other.
 */

const OFF_VALUES = new Set(["off", "0", "false"]);
const LOCAL_PROFILES = new Set(["development", "preview"]);

function httpOrigin(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin.toLowerCase();
}

function isLocalHttpOrigin(origin) {
  const m = /^http:\/\/([^/:]+)(:\d+)?$/.exec(origin);
  if (!m) return false;
  const host = m[1];
  if (host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2") return true;
  const oct = host.split(".").map(Number);
  if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = oct[0];
  const b = oct[1];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** The problems with a build env, or [] when the shell would be ON for it. */
function checkShellEnv(env, opts = {}) {
  const problems = [];
  const rawUrl = (env.EXPO_PUBLIC_WEB_URL || "").trim();
  const flag = (env.EXPO_PUBLIC_WEB_SHELL || "").trim().toLowerCase();

  if (!flag) {
    problems.push('EXPO_PUBLIC_WEB_SHELL is not set (it must be "on").');
  } else if (OFF_VALUES.has(flag)) {
    problems.push(`EXPO_PUBLIC_WEB_SHELL is "${flag}": the shell is off, the old native UI ships.`);
  }

  if (!rawUrl) {
    problems.push(
      "EXPO_PUBLIC_WEB_URL is not set: the shell would be off and the old native UI would ship.",
    );
  } else {
    const origin = httpOrigin(rawUrl);
    if (!origin) {
      problems.push(`EXPO_PUBLIC_WEB_URL is not an http(s) URL: ${rawUrl}`);
    } else if (!origin.startsWith("https://")) {
      if (!opts.allowLocalHttp) {
        problems.push(`EXPO_PUBLIC_WEB_URL must be https for this build, got ${origin}.`);
      } else if (!isLocalHttpOrigin(origin)) {
        problems.push(
          `EXPO_PUBLIC_WEB_URL is plain http and not a local / private-LAN host: ${origin}.`,
        );
      }
    }
  }
  return problems;
}

function main(argv, env) {
  const eas = argv.includes("--eas");
  const profile = (env.EAS_BUILD_PROFILE || "").trim();
  const allowLocalHttp = eas && LOCAL_PROFILES.has(profile);
  const problems = checkShellEnv(env, { allowLocalHttp });
  if (problems.length === 0) {
    const where = eas ? `EAS build (profile ${profile || "unknown"})` : "OTA publish";
    console.log(`assert-shell-env: ok for ${where}, web ${httpOrigin(env.EXPO_PUBLIC_WEB_URL)}`);
    return 0;
  }
  console.error("assert-shell-env: REFUSED - this build would not carry the new web shell:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "Set both EXPO_PUBLIC_WEB_URL and EXPO_PUBLIC_WEB_SHELL=on for this build or publish " +
      "(see eas.json for the profile values), then run it again.",
  );
  return 1;
}

module.exports = { checkShellEnv };

if (require.main === module) {
  process.exit(main(process.argv.slice(2), process.env));
}
