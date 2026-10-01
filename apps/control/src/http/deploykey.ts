/** Deploy key + pinned GitHub host keys, written 0600 under a private dir; returns GIT_SSH_COMMAND. */
import * as fs from "node:fs";
import * as path from "node:path";

/** GitHub's published ed25519 host key (verify against https://api.github.com/meta ssh_keys). */
export const GITHUB_KNOWN_HOSTS =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";

export function setupDeployKey(b64: string, dir: string): string {
  const key = Buffer.from(b64, "base64").toString("utf8").trim();
  if (key === "") throw new Error("CONTROL_DEPLOY_KEY_B64 is not valid base64");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "deploy_key");
  fs.writeFileSync(keyFile, key + "\n", { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const hosts = path.join(dir, "known_hosts");
  fs.writeFileSync(hosts, GITHUB_KNOWN_HOSTS, { mode: 0o600 });
  return (
    `ssh -i '${keyFile}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes ` +
    `-o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile='${hosts}'`
  );
}
