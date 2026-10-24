/**
 * #2631 / SA-550 / 550a / SA-706f — source tripwire for the routes lock order (the billing
 * tenant-lock-order.tripwire's style): the house order is Orders → STOP rows → RouteRun; the STOP
 * row is the serialization point between a run's terminal transition and a stop completion.
 *
 *   (i)   updateRunStatus's terminal-status transaction takes lockRunOrdersForTerminalStatus as its
 *         FIRST statement and lockRunStopsForTerminalStatus as its SECOND — before any routeRun /
 *         order / changeRequest write;
 *   (ii)  completeStop and completeWithPayment touch NO RouteRun (read or write) inside their
 *         transaction before claimStopCompletion, and re-check the run with assertRunStillInProgress
 *         right after it, before any order write;
 *   (iii) reopenStop and deleteRoute (Order-first, SA-214) run under retryOnTxConflict, so their
 *         reopen × cancel / delete × cancel races retry instead of surfacing a 500.
 *
 * Comments are stripped first (a call in a comment is not a call). A reorder that breaks one of these
 * is a red build; changing the rule means changing this file on purpose.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "routes.service.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/\/\/.*$/gm, (m) => " ".repeat(m.length));

/** The body of `async <name>(` — brace-matched from the method's opening brace. */
function methodBody(name: string): string {
  const m = new RegExp(`\\n  async ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`tripwire: method ${name} not found — update this spec`);
  const open = SRC.indexOf("{", SRC.indexOf(")", m.index));
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(open, i + 1);
  }
  throw new Error("tripwire: unbalanced braces");
}

/** The text of the FIRST transaction callback in `body` (from `async (tx) => {` to its close). */
function firstTxCallback(body: string): string {
  const head = /tenantTransaction\(async \(tx\) => \{/.exec(body);
  if (!head) throw new Error("tripwire: no tenantTransaction callback found");
  const open = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) return body.slice(open, i + 1);
  }
  throw new Error("tripwire: unbalanced tx callback");
}

const at = (hay: string, needle: RegExp) => {
  const m = needle.exec(hay);
  return m ? m.index : -1;
};

describe("routes lock order: Orders → STOP rows → RouteRun (#2631, SA-550, SA-706f)", () => {
  it("(i) updateRunStatus: the terminal tx locks the run's Orders FIRST, then its stop rows, before any write", () => {
    const cb = firstTxCallback(methodBody("updateRunStatus"));
    const firstStatement = cb.slice(1).trim();
    expect(
      firstStatement.startsWith(
        "const lockedOrderIds = await lockRunOrdersForTerminalStatus(tx, id, run.tenantId)",
      ),
    ).toBe(true);
    const orders = at(cb, /lockRunOrdersForTerminalStatus\(/);
    const lock = at(cb, /lockRunStopsForTerminalStatus\(/);
    expect(lock).toBeGreaterThan(orders);
    for (const write of [/tx\.routeRun\.update\(/, /releaseUndeliveredOrders\(/, /tx\.order\./]) {
      const w = at(cb, write);
      if (w >= 0) expect(lock).toBeLessThan(w);
    }
  });

  it.each(["completeStop", "completeWithPayment"])(
    "(ii) %s: no RouteRun access in the tx before claimStopCompletion; the re-check follows it, before any order write",
    (name) => {
      const body = methodBody(name);
      const txStart = at(body, /tenantTransaction\(async \(tx\) => \{|withAfterCommit\(/);
      expect(txStart).toBeGreaterThan(-1);
      const inTx = body.slice(txStart);
      const claim = at(inTx, /claimStopCompletion\(tx, stopId/);
      const recheck = at(inTx, /assertRunStillInProgress\(tx, runId\)/);
      const firstRun = at(inTx, /tx\.routeRun\.|"RouteRun"/);
      const firstOrderWrite = at(inTx, /tx\.order\.update(Many)?\(/);
      expect(claim).toBeGreaterThan(-1);
      expect(recheck).toBeGreaterThan(claim);
      if (firstRun >= 0) expect(firstRun).toBeGreaterThan(claim);
      if (firstOrderWrite >= 0) expect(recheck).toBeLessThan(firstOrderWrite);
    },
  );

  it.each([
    ["reopenStop", "routes.reopenStop"],
    ["deleteRoute", "routes.deleteRoute"],
  ])("(iii) %s runs its transaction under retryOnTxConflict", (name, label) => {
    const body = methodBody(name);
    expect(body).toMatch(
      new RegExp(
        `retryOnTxConflict\\("${label.replace(".", "\\.")}", \\(\\) =>\\s*this\\.prisma\\.tenantTransaction\\(`,
      ),
    );
  });

  it("(iv) updateRunStatus's terminal tx runs under retryRouteTx (its stop locks invert reorder / optimize)", () => {
    const body = methodBody("updateRunStatus");
    expect(body).toMatch(
      /retryRouteTx\("routes\.updateRunStatus", \(\) =>\s*this\.prisma\.tenantTransaction\(async \(tx\) => \{\s*const lockedOrderIds = await lockRunOrdersForTerminalStatus\(tx, id, run\.tenantId\)/,
    );
  });

  // SA-550d belt: every writer of a run's STOP positions retries a lock conflict with a run transition
  // (a cancel), and builds its batch INSIDE the retry callback (batch PrismaPromises are single-use).
  // optimizeTemplate writes RouteStop (the route template), not RouteRunStop, so it is not listed.
  it("(vi) reorderRunStops runs its tx under retryOnTxConflict", () => {
    expect(methodBody("reorderRunStops")).toMatch(
      /retryOnTxConflict\("routes\.reorderRunStops", \(\) =>\s*this\.prisma\.tenantTransaction\(/,
    );
  });

  // (v) SA-550g option (b): the stop-row-lock-first ORDER inside reorderRunStopsInTx is pinned ONCE,
  // in #2691's run-stop-reorder.lock-order.spec.ts. This pins only what #2679 adds: the retry wrapper
  // hands the tx STRAIGHT to reorderRunStopsInTx — no tx statement runs before its stop lock.
  it("(v) reorderRunStops's retry callback's FIRST tx operation is reorderRunStopsInTx(tx, …)", () => {
    const body = methodBody("reorderRunStops");
    expect(body).toMatch(/tenantTransaction\(\(tx(?::\s*any)?\) =>\s*reorderRunStopsInTx\(tx,/);
    const before = body.slice(0, at(body, /reorderRunStopsInTx\(tx,/));
    expect(before).not.toMatch(/\btx\.|\$queryRaw|\$executeRaw/);
  });

  it.each([
    [
      "optimizeRoute",
      /retryOnTxConflict\("routeOptimization\.optimizeRoute", \(\) =>\s*this\.prisma\.\$transaction\(\[/,
    ],
    [
      "applyRouteVariant",
      /retryOnTxConflict\("routeOptimization\.applyRouteVariant", \(\) =>\s*this\.prisma\.\$transaction\(buildOps\(\)\)/,
    ],
  ])(
    "(vi) route-optimization %s builds its stop batch INSIDE a retryOnTxConflict callback",
    (name, re) => {
      const src = readFileSync(
        join(__dirname, "..", "route-optimization", "route-optimization.service.ts"),
        "utf8",
      ).replace(/\/\/.*$/gm, "");
      const m = new RegExp(`\\n  async ${name}\\(`).exec(src);
      expect(m).not.toBeNull();
      const from = m!.index;
      const next = src.indexOf("\n  async ", from + 5);
      const body = src.slice(from, next === -1 ? undefined : next);
      expect(body).toMatch(re);
      // No bare batch transaction left in the method (a stale, pre-built array reused on retry).
      expect(body).not.toMatch(/await this\.prisma\.\$transaction\((\[|ops\))/);
    },
  );

  it("(iii) reopenStop resets its outer `reopened` list at the top of each attempt (a retry never duplicates)", () => {
    const cb = firstTxCallback(methodBody("reopenStop"));
    expect(cb.slice(1).trim().startsWith("reopened.length = 0;")).toBe(true);
  });
});
