import fs from "node:fs";
import path from "node:path";

// B579 — schedule-local-backup.ps1 registers a Task Scheduler action `cmd.exe /c <argument>`.
// cmd.exe has a notorious quote rule (`cmd /?`): when the text after /c starts with a quote and
// does not meet the "exactly two quotes around an executable" exception, cmd strips the FIRST
// character (the leading quote) and the LAST quote of the whole line. A command that starts with
// a quoted path and later quotes the log file — exactly ours — is mangled unless the whole thing
// is wrapped in one extra outer pair. There is no PowerShell/cmd on every dev machine, so this
// spec evaluates the script's own `$Command` / `$Argument` lines (with sample paths that contain
// spaces) and applies cmd's documented rule to them.

const PS1 = fs.readFileSync(
  path.resolve(__dirname, "../../scripts/schedule-local-backup.ps1"),
  "utf8",
);

const VARS: Record<string, string> = {
  Railway: "C:\\Program Files\\nodejs\\railway.cmd",
  Script: "apps\\api\\scripts\\backup-production.mjs",
  LogFile: "C:\\my repo\\backups\\task-scheduler.log",
};

/** Evaluate one PowerShell double-quoted string literal: `" -> ", `$ -> $, $Var -> its value. */
function evalPsString(literal: string, vars: Record<string, string>): string {
  const inner = literal.slice(1, -1); // drop the outer double quotes
  return inner
    .replace(/`"/g, '"')
    .replace(/`\$/g, "$")
    .replace(/\$([A-Za-z]+)/g, (_m, name: string) => {
      if (!(name in vars)) throw new Error(`spec has no value for $${name}`);
      return vars[name];
    });
}

function assignment(name: string): string {
  const m = new RegExp(`^\\$${name}\\s*=\\s*(".*")\\s*$`, "m").exec(PS1);
  if (!m) throw new Error(`$${name} assignment not found in schedule-local-backup.ps1`);
  return m[1];
}

/**
 * What cmd.exe actually executes for `cmd.exe <argument>` where argument = "/c <rest>" (no /S):
 * the documented "old behaviour" — if the first character of <rest> is a quote, strip it and the
 * LAST quote on the line; otherwise leave <rest> alone. (The two-quote exception only applies to
 * `"exe" args` with exactly two quotes, which a redirected log path always violates.)
 */
function cmdEffectiveCommand(argument: string): string {
  expect(argument.startsWith("/c ")).toBe(true);
  const rest = argument.slice(3);
  if (!rest.startsWith('"')) return rest;
  const quotes = (rest.match(/"/g) ?? []).length;
  if (quotes === 2 && !/[&<>()@^|]/.test(rest.slice(1, rest.lastIndexOf('"')))) return rest; // exception
  const last = rest.lastIndexOf('"');
  return rest.slice(1, last) + rest.slice(last + 1);
}

describe("schedule-local-backup.ps1 — cmd.exe /c quoting (B579)", () => {
  const command = evalPsString(assignment("Command"), VARS);
  const argument = evalPsString(assignment("Argument"), { ...VARS, Command: command });

  it("$Command is the intended command line: quoted railway path, quoted log redirect", () => {
    expect(command).toBe(
      '"C:\\Program Files\\nodejs\\railway.cmd" run --service postgres node ' +
        'apps\\api\\scripts\\backup-production.mjs scheduled >> "C:\\my repo\\backups\\task-scheduler.log" 2>&1',
    );
  });

  it("after cmd's quote stripping, the command that RUNS is exactly $Command (unmangled)", () => {
    expect(cmdEffectiveCommand(argument)).toBe(command);
  });

  it("the OLD form (no outer wrap) is mangled by the same rule — so this check can fail", () => {
    const old = `/c ${command}`;
    const effective = cmdEffectiveCommand(old);
    expect(effective).not.toBe(command);
    // the railway path lost its opening quote and the log path lost its closing one
    expect(effective.startsWith("C:\\Program Files")).toBe(true);
    expect(effective).toMatch(/task-scheduler\.log 2>&1$/);
  });

  it("logs stdout AND stderr (2>&1) so a failed scheduled backup is never silent", () => {
    expect(cmdEffectiveCommand(argument)).toMatch(/>> "[^"]+" 2>&1$/);
  });

  it("offers a -DryRun switch that prints the action and exits before Register-ScheduledTask", () => {
    expect(PS1).toMatch(/\[switch\]\$DryRun/);
    const dry = PS1.indexOf("if ($DryRun)");
    const register = PS1.indexOf("Register-ScheduledTask");
    expect(dry).toBeGreaterThan(-1);
    expect(dry).toBeLessThan(register);
  });
});
