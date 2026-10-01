// Parse audit-2026-04-29.md and build targets.json
const fs = require("fs");
const path = require("path");

const AUDIT = fs.readFileSync(path.join(__dirname, "..", "audit-2026-04-29.md"), "utf8");

const P0 = [
  "RF-001",
  "RF-002",
  "RF-003",
  "RF-073",
  "RF-074",
  "RF-075",
  "RF-076",
  "RF-077",
  "RF-147",
  "RF-157",
  "RF-176",
  "RF-197",
  "RF-203",
];
const P1 = [
  "RF-004",
  "RF-005",
  "RF-006",
  "RF-007",
  "RF-008",
  "RF-009",
  "RF-010",
  "RF-011",
  "RF-012",
  "RF-013",
  "RF-014",
  "RF-015",
  "RF-016",
  "RF-017",
  "RF-018",
  "RF-019",
  "RF-078",
  "RF-079",
  "RF-080",
  "RF-081",
  "RF-082",
  "RF-083",
  "RF-084",
  "RF-085",
  "RF-086",
  "RF-087",
  "RF-088",
  "RF-089",
  "RF-090",
  "RF-091",
  "RF-092",
  "RF-093",
  "RF-094",
  "RF-130",
  "RF-134",
  "RF-135",
  "RF-136",
  "RF-141",
  "RF-158",
  "RF-159",
  "RF-160",
  "RF-167",
  "RF-168",
  "RF-172",
  "RF-180",
  "RF-200",
  "RF-204",
  "RF-205",
  "RF-211",
  "RF-212",
  "RF-213",
  "RF-215",
  "RF-216",
  "RF-217",
  "RF-218",
];
const P2 = [
  "RF-198",
  "RF-201",
  "RF-202",
  "RF-206",
  "RF-209",
  "RF-213",
  "RF-214",
  "RF-219",
  "RF-221",
  "RF-222",
  "RF-223",
  "RF-224",
  "RF-225",
  "RF-226",
  "RF-227",
  "RF-228",
  "RF-229",
  "RF-231",
  "RF-232",
  "RF-233",
];
// Note: RF-213 is already P1 — drop it from P2 list
const P2u = P2.filter((id) => !P1.includes(id));

function parseSection(id) {
  const re = new RegExp(`^### (${id}) — (.*?)$([\\s\\S]*?)(?=^### RF-|\\Z)`, "m");
  const m = AUDIT.match(re);
  if (!m) return null;
  const title = m[2].replace(/\s*\(P[0-3]\)\s*$/, "").trim();
  const body = m[3];
  function field(name) {
    const r = new RegExp(
      `^- \\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=^- \\*\\*|\\n###|\\n---|\\Z)`,
      "m",
    );
    const fm = body.match(r);
    return fm ? fm[1].trim().replace(/\s+/g, " ") : "";
  }
  const sev = field("Severity").replace(/\s.*/, "");
  const surfRaw = field("Surface").toLowerCase();
  let surface;
  if (/mobile-driver/.test(surfRaw)) surface = "mobile-driver";
  else if (/mobile-buyer|buyer.*portal/.test(surfRaw)) surface = "mobile-buyer";
  else if (/web-buyer|buyer/.test(surfRaw)) surface = "web-buyer";
  else if (/web-operator|web-op|operator/.test(surfRaw)) surface = "web-op";
  else if (/api/.test(surfRaw)) surface = "api";
  else surface = surfRaw || "api";
  const repro = field("Repro")
    .replace(/\d+\.\s*/g, "| ")
    .replace(/^\|\s*/, "")
    .slice(0, 240);
  const expected = field("Expected").slice(0, 200);
  return { id, title: title.slice(0, 140), severity: sev, surface, repro, expected };
}

function build(ids) {
  return ids.map(parseSection).filter(Boolean);
}

const targets = {
  generated: "2026-05-01",
  env: {
    url: "https://routeflowmobile-production.up.railway.app",
    api: "https://routeflowapi-production.up.railway.app/api/v1",
    tenant: "ux-audit-1777265477001",
  },
  P0: build(P0),
  P1: build(P1),
  P2: build(P2u),
};

fs.writeFileSync(path.join(__dirname, "targets.json"), JSON.stringify(targets, null, 2));
console.log(`P0=${targets.P0.length} P1=${targets.P1.length} P2=${targets.P2.length}`);
console.log(`Bytes: ${fs.statSync(path.join(__dirname, "targets.json")).size}`);
