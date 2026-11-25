// SA-1248: the local mailpit TLS pair is generated per machine, never tracked.
// ensureMailpitTls keeps a valid pair and otherwise generates one (openssl, else a pinned docker
// image). It never prints key material. Callers: scripts/local-env.mjs.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OPENSSL_IMAGE = "alpine/openssl:3.5.4";
const SUBJECT = "/CN=routeflow-local-mailpit";
const SAN = "subjectAltName=DNS:localhost,DNS:mailpit,IP:127.0.0.1,IP:::1";

const defaultRun = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return { status: r.error ? null : r.status };
};

function pairIsValid(certPath, keyPath, now) {
  try {
    if (!fs.existsSync(keyPath)) return false;
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    return (cert.subjectAltName ?? "").includes("mailpit") && Date.parse(cert.validTo) > now;
  } catch {
    return false;
  }
}

export function ensureMailpitTls({ repoRoot, run = defaultRun, now = Date.now() }) {
  const dir = path.join(repoRoot, "docker", "mailpit-tls");
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  if (pairIsValid(certPath, keyPath, now)) return { generated: false };

  const req = (key, cert) => [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "3650",
    "-subj",
    SUBJECT,
    "-addext",
    SAN,
  ];
  fs.mkdirSync(dir, { recursive: true });
  let ok = run("openssl", req(keyPath, certPath)).status === 0;
  if (!ok) {
    const mount = `${path.resolve(dir)}:/out`;
    ok =
      run("docker", [
        "run",
        "--rm",
        "-v",
        mount,
        OPENSSL_IMAGE,
        ...req("/out/key.pem", "/out/cert.pem"),
      ]).status === 0;
  }
  if (!ok || !pairIsValid(certPath, keyPath, now)) {
    throw new Error(
      "mailpit tls: cannot generate the local TLS pair; install openssl or start Docker (needs one of the two)",
    );
  }
  return { generated: true };
}
