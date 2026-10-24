/**
 * Server-token PR: the master clone's `origin` is the product repo (`masterOrigin`), never the
 * state repo. Without the dep, the old single-origin behaviour (fixtures, tests) is unchanged.
 * Local file:// repos only.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startServer } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { git, makeWorld } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

let h: Harness | undefined;
let product: World | undefined;
let dir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  product?.cleanup();
  product = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const originOf = (masterDir: string): string =>
  git(masterDir, ["config", "--get", "remote.origin.url"]).trim();

describe("ensureMaster origin", () => {
  it("clones the master from masterOrigin, not from the state origin", async () => {
    product = makeWorld();
    product.seedBranch("master", { "README.md": "product master\n" });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-origin-"));
    const masterDir = path.join(dir, "master");
    h = await startServer({
      depsOver: { masterOrigin: product.originUrl, masterDir },
    });
    expect(product.originUrl).not.toBe(h.world.originUrl);
    await h.app.tick();
    expect(originOf(masterDir)).toBe(product.originUrl);
    expect(originOf(masterDir)).not.toBe(h.world.originUrl);
    // and the fetch really came from the product repo
    expect(git(masterDir, ["rev-parse", "refs/remotes/origin/master"]).trim()).toBe(
      product.remoteHead("master"),
    );
  });

  it("without masterOrigin it keeps the old behaviour: the env origin", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-origin-"));
    const masterDir = path.join(dir, "master");
    h = await startServer({ depsOver: { masterDir } });
    await h.app.tick();
    expect(originOf(masterDir)).toBe(h.world.originUrl);
  });

  it("a masterOrigin that looks like an option is refused (no clone is made)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-origin-"));
    const masterDir = path.join(dir, "master");
    h = await startServer({ depsOver: { masterOrigin: "--upload-pack=evil", masterDir } });
    await h.app.tick();
    expect(fs.existsSync(path.join(masterDir, ".git"))).toBe(false);
  });

  // review F5: a clone left by an older boot keeps its old origin (e.g. an ssh URL) and would fetch from
  // it forever; the configured masterOrigin must win.
  it("an existing master clone with an old origin is re-pointed at masterOrigin", async () => {
    product = makeWorld();
    product.seedBranch("master", { "README.md": "product master\n" });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-origin-"));
    const masterDir = path.join(dir, "master");
    fs.mkdirSync(masterDir);
    git(masterDir, ["init", "-q"]);
    git(masterDir, ["remote", "add", "origin", "ssh://old-host/acme/acme-old.git"]);
    h = await startServer({ depsOver: { masterOrigin: product.originUrl, masterDir } });
    await h.app.tick();
    expect(originOf(masterDir)).toBe(product.originUrl);
    expect(git(masterDir, ["rev-parse", "refs/remotes/origin/master"]).trim()).toBe(
      product.remoteHead("master"),
    );
    expect(git(masterDir, ["remote"]).trim().split("\n")).toEqual(["origin"]);
  });

  it("an existing clone already on masterOrigin is left alone", async () => {
    product = makeWorld();
    product.seedBranch("master", { "README.md": "product master\n" });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-origin-"));
    const masterDir = path.join(dir, "master");
    fs.mkdirSync(masterDir);
    git(masterDir, ["init", "-q"]);
    git(masterDir, ["remote", "add", "origin", product.originUrl]);
    git(masterDir, [
      "config",
      "remote.origin.fetch",
      "+refs/heads/master:refs/remotes/origin/master",
    ]);
    h = await startServer({ depsOver: { masterOrigin: product.originUrl, masterDir } });
    await h.app.tick();
    expect(originOf(masterDir)).toBe(product.originUrl);
    // set-url would not touch the refspec; neither did we
    expect(git(masterDir, ["config", "--get", "remote.origin.fetch"]).trim()).toBe(
      "+refs/heads/master:refs/remotes/origin/master",
    );
  });

  it("an existing clone is never re-pointed at an option-looking masterOrigin", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-origin-"));
    const masterDir = path.join(dir, "master");
    fs.mkdirSync(masterDir);
    git(masterDir, ["init", "-q"]);
    git(masterDir, ["remote", "add", "origin", "file:///nonexistent/old.git"]);
    h = await startServer({ depsOver: { masterOrigin: "--upload-pack=evil", masterDir } });
    await h.app.tick();
    expect(originOf(masterDir)).toBe("file:///nonexistent/old.git");
  });
});
