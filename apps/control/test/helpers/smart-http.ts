/**
 * A tiny smart-HTTP git server on 127.0.0.1 for specs: serves one bare repo through
 * `git http-backend`, records every request (method, url, host, authorization), and can answer a
 * 302 for the ref advertisement instead. It runs in a CHILD process (`smart-http-server.js`)
 * because specs drive git with spawnSync, which would deadlock a same-process server.
 * Local only; never the network.
 */
import { execFileSync, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OFFLINE_GIT_ENV } from "./temp-repo";

export interface SeenRequest {
  method: string;
  url: string;
  host: string;
  authorization: string | undefined;
}

export interface SmartHttp {
  port: number;
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** Repo URL: `<base>/repo.git` */
  repoUrl: string;
  /** Every request received so far (read from the child's log). */
  readonly seen: SeenRequest[];
  close(): Promise<void>;
}

export interface SmartHttpOpts {
  /** Answer every `info/refs` with a 302 to `<redirectTo>/repo.git/info/refs?...`; "@localhost"
   * means the same port under the host name `localhost`. */
  redirectTo?: string;
}

const GIT_ENV = {
  ...process.env,
  ...OFFLINE_GIT_ENV, // the seed/bare setup is local; only the spec's own git talks http
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
};
const sh = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
};

/** Serve a bare repo (one commit on `main`, file a.txt) at `/repo.git`. */
export async function startSmartHttp(opts: SmartHttpOpts = {}): Promise<SmartHttp> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smart-http-"));
  const bare = path.join(root, "repo.git");
  const seed = path.join(root, "seed");
  const logPath = path.join(root, "seen.log");
  fs.mkdirSync(bare);
  fs.mkdirSync(seed);
  fs.writeFileSync(logPath, "");
  sh(bare, ["init", "-q", "--bare", "--initial-branch=main"]);
  sh(seed, ["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(seed, "a.txt"), "hello\n");
  sh(seed, ["add", "-A"]);
  sh(seed, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
  sh(seed, ["push", "-q", bare, "HEAD:refs/heads/main"]);

  const args = [path.join(__dirname, "smart-http-server.js"), root, logPath];
  if (opts.redirectTo) args.push(opts.redirectTo);
  const child: ChildProcess = spawn("node", args, { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("smart-http server exited early")));
    child.stdout?.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    repoUrl: `${base}/repo.git`,
    get seen(): SeenRequest[] {
      return fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as SeenRequest);
    },
    close: () =>
      new Promise<void>((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", () => {
          fs.rmSync(root, { recursive: true, force: true });
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
