import fs from "node:fs";

/**
 * D-03 (#1803): load the local-only throwaway super-admin (`local-assets/local-sa.env`, minted by `npm run local:sa`)
 * into the Playwright child's environment. `local:e2e` targets ONLY the local compose stack, and that file's
 * credentials exist only in that stack's database, so when the file is present it WINS over an exported
 * PLAYWRIGHT_SA_* (an exported `qa_billing_sa` for some other target silently shadowed it and made the setup's
 * login fail with a 401 that looked like a CORS problem). Overriding a value the shell exported is never silent: a
 * loud warning names the variable and that its exported value was ignored (never printing either value).
 *
 * Only the two PLAYWRIGHT_SA_* names are ever taken. A file that is not owner-only on POSIX (a loose or group/world
 * readable copy) is ignored entirely; on Windows the mode cannot be checked (Node reports 666), so the file is
 * loaded and the folder's ACLs govern. Absent file = the environment is untouched and the super-admin specs skip
 * exactly as before. Pure apart from reading the file; returns what it did.
 */
export function loadLocalSaEnv(
  env,
  file,
  { platform = process.platform, warn = console.warn } = {},
) {
  let text;
  try {
    if (platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0)
      return { loaded: false, reason: "mode" };
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { loaded: false, reason: "absent" };
  }
  const shadowed = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(PLAYWRIGHT_SA_USERNAME|PLAYWRIGHT_SA_PASSWORD)=(.+)$/.exec(line);
    if (!m) continue;
    if (env[m[1]] && env[m[1]] !== m[2]) shadowed.push(m[1]);
    env[m[1]] = m[2];
  }
  if (shadowed.length > 0) {
    warn(
      `local-env: WARNING — ${shadowed.join(" and ")} was already exported in this shell and is being IGNORED: ` +
        `the local lane uses the throwaway super-admin from local-assets/local-sa.env (minted by \`npm run local:sa\`). ` +
        `Unset the exported value to silence this.`,
    );
  }
  return { loaded: true, shadowed };
}
