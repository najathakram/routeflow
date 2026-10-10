// B806: the compile half of scripts/check-types-ratchet.mjs. Runs in its own Node process (the
// parent sets the heap) so it can report the compiler's OWN wall time and peak RSS portably:
// process.resourceUsage().maxRSS is the same measure on macOS and Linux. Prints one JSON line.
import path from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { isNoCheckFile } from "./check-types-ratchet-core.mjs";

const started = performance.now();
const configPath = path.resolve(process.argv[2] ?? "tsconfig.spec.json");
const apiDir = path.dirname(configPath);

const parsed = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  },
);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: { ...parsed.options, noEmit: true, incremental: false },
  projectReferences: parsed.projectReferences,
  configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
});
const rel = (f) => path.relative(apiDir, f).split(path.sep).join("/");
const nocheck = program
  .getSourceFiles()
  .filter((sf) => !rel(sf.fileName).startsWith("..") && !sf.isDeclarationFile)
  .filter((sf) => isNoCheckFile(sf))
  .map((sf) => rel(sf.fileName));
const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ({
  file: d.file ? rel(d.file.fileName) : null,
  line:
    d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
  code: d.code,
  message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
}));

process.stdout.write(
  JSON.stringify({
    files: parsed.fileNames.length,
    diagnostics,
    nocheck,
    wallMs: Math.round(performance.now() - started),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }) + "\n",
);
