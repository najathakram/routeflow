/**
 * `apps/api/src/orders/merge-contention.ts` — the recognition half of PR-2's invariant.
 *
 * `isMergeContention` is what every POST-COMMIT consolidation call uses to decide "swallow, or
 * rethrow". It discriminates by response CODE, never by exception type, and that distinction is
 * the whole test: the merge path raises plenty of 409s and 503s that are NOT lock contention
 * (a credit-limit conflict, a dead dependency), and swallowing one of those would hide a broken
 * merge behind a warning line forever.
 */

import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import {
  LOCK_UNAVAILABLE,
  MERGE_IN_PROGRESS,
  isMergeContention,
  mapLockError,
} from "./merge-contention";
import { LockTimeoutError, LockUnavailableError } from "../common/db-locks";

describe("merge-contention — isMergeContention (PR-2 / imp-02)", () => {
  it("is true for the coded 409 the merge lock raises on a timeout", () => {
    const e = new ConflictException({
      code: MERGE_IN_PROGRESS,
      message: "Another merge for this customer is in progress — retry.",
    });
    expect(isMergeContention(e)).toBe(true);
  });

  it("is true for the coded 503 the merge lock raises when no lock connection is available", () => {
    const e = new ServiceUnavailableException({
      code: LOCK_UNAVAILABLE,
      message: "Order merge lock unavailable — retry shortly.",
    });
    expect(isMergeContention(e)).toBe(true);
  });

  it("is false for a 409 raised for some other reason — an uncoded one, and a differently-coded one", () => {
    // The pre-fix sweep skipped by TYPE, so both of these were silently swallowed: a genuine
    // merge fault looked exactly like contention and the hourly sweep never surfaced it.
    expect(isMergeContention(new ConflictException("An open draft order exists"))).toBe(false);
    expect(isMergeContention(new ConflictException({ code: "MERGE_CHOICE_REQUIRED" }))).toBe(false);
    expect(isMergeContention(new ConflictException({ message: "no code at all" }))).toBe(false);
  });

  it("is false for a 503 with a string body and for a differently-coded 503", () => {
    expect(isMergeContention(new ServiceUnavailableException("Merge lock unavailable"))).toBe(
      false,
    );
    expect(isMergeContention(new ServiceUnavailableException({ code: "DB_DOWN" }))).toBe(false);
  });

  it("is false for a plain Error, and for non-Error values", () => {
    expect(isMergeContention(new Error("boom"))).toBe(false);
    expect(isMergeContention(undefined)).toBe(false);
    expect(isMergeContention(null)).toBe(false);
    expect(isMergeContention("MERGE_IN_PROGRESS")).toBe(false);
    expect(isMergeContention({ code: MERGE_IN_PROGRESS })).toBe(false);
  });
});

describe("merge-contention — mapLockError (PR-2 / imp-02)", () => {
  it("maps a LockTimeoutError to a 409 whose body carries MERGE_IN_PROGRESS", () => {
    let caught: any;
    try {
      mapLockError(new LockTimeoutError("order-merge", "cust-1", 10_000));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.getStatus()).toBe(409);
    expect(caught.getResponse()).toMatchObject({ code: MERGE_IN_PROGRESS });
    // Round-trip: what mapLockError raises is exactly what the post-commit callers recognise.
    expect(isMergeContention(caught)).toBe(true);
  });

  it("maps a LockUnavailableError to a 503 whose body carries LOCK_UNAVAILABLE", () => {
    let caught: any;
    try {
      mapLockError(new LockUnavailableError(new Error("pool exhausted")));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(caught.getStatus()).toBe(503);
    expect(caught.getResponse()).toMatchObject({ code: LOCK_UNAVAILABLE });
    expect(isMergeContention(caught)).toBe(true);
  });

  it("rethrows anything else untouched — a dead lock connection must not become a retryable 409", () => {
    const adminShutdown = Object.assign(new Error("terminating connection"), { code: "57P01" });
    expect(() => mapLockError(adminShutdown)).toThrow(adminShutdown);
  });
});
