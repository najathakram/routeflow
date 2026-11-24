// Lints a commit subject with the same rules the commit-msg hook applies (commitlint.config.js).
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function run(args, { cwd = ROOT } = {}) {
  const subject = args[0];
  if (!subject)
    return { code: 2, lines: ['usage: node scripts/fleet.mjs subject-check "<subject>"'] };
  const { default: load } = await import("@commitlint/load");
  const { default: lint } = await import("@commitlint/lint");
  const config = await load({}, { cwd });
  const report = await lint(subject, config.rules, {
    parserOpts: config.parserPreset?.parserOpts,
  });
  if (report.valid) return { code: 0, lines: [`ok (${subject.length} chars)`] };
  const lines = [...report.errors, ...report.warnings].map((r) => `${r.name}: ${r.message}`);
  return { code: 1, lines };
}
