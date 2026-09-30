import {
  DELIVERY_FIX_LINK_VALUES,
  DELIVERY_REASON_CODE_VALUES,
  deliveryFixTarget,
  describeDeliveryReason,
} from "./reason-copy";

describe("reason-copy (#1965)", () => {
  it("T15 every closed reason code has a sentence that does not echo the code", () => {
    for (const code of DELIVERY_REASON_CODE_VALUES) {
      const s = describeDeliveryReason(code);
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toContain(code);
    }
  });

  it("T15b an unknown/raw code falls back to a generic sentence and never echoes the input", () => {
    const s = describeDeliveryReason("SMTP 550 5.1.1 user unknown");
    expect(s).not.toMatch(/smtp|550/i);
    expect(s.length).toBeGreaterThan(10);
  });

  it("T15c every fix-link value resolves (NONE -> null, others -> label + /settings href)", () => {
    for (const v of DELIVERY_FIX_LINK_VALUES) {
      const t = deliveryFixTarget(v);
      if (v === "NONE") expect(t).toBeNull();
      else expect(t?.href).toMatch(/^\/settings/);
    }
  });
});

import { RETURN_REASON_VALUES } from "@routeflow/types";
import {
  RECORDS_FAILED_COPY,
  SCAN_FAILED_COPY,
  describeReturnReason,
  describeRunFailure,
  describeSaveError,
} from "./reason-copy";

describe("reason-copy: run failures, return reasons, save errors (#1965)", () => {
  it("describeRunFailure: the unfinalized prefix is never retryable and never echoes the server text", () => {
    const r = describeRunFailure(
      "The invoice was created but the run could not be finalized (invoice abc): P2002 boom",
    );
    expect(r.retryable).toBe(false);
    expect(r.text).not.toMatch(/P2002|abc|boom/);
  });

  it("describeRunFailure: an unknown failure gets the generic retry sentence with no raw text", () => {
    const r = describeRunFailure("connect ECONNREFUSED 10.0.0.5:5432");
    expect(r.retryable).toBe(true);
    expect(r.text).toMatch(/run now/i);
    expect(r.text).not.toMatch(/ECONN|10\.0/);
  });

  it("describeRunFailure: a selling-restriction suspension keeps a readable fixed sentence", () => {
    const r = describeRunFailure("Suspended: a line is under a selling restriction (Acme Widget).");
    expect(r.text).toMatch(/selling restriction/i);
    expect(r.text).not.toMatch(/Acme Widget/);
  });

  it("describeReturnReason: every ReturnReason has copy; an unknown value never echoes", () => {
    for (const v of RETURN_REASON_VALUES) expect(describeReturnReason(v)).not.toBe(v);
    expect(describeReturnReason("drop table")).not.toMatch(/drop table/);
  });

  it("describeSaveError maps the HTTP status to a fixed sentence, never the axios message", () => {
    const axiosErr = (status: number) => ({
      message: "Request failed with status code " + status,
      response: { status, data: { message: "raw server text" } },
    });
    for (const s of [400, 403, 409, 500]) {
      const t = describeSaveError(axiosErr(s));
      expect(t).not.toMatch(/Request failed|raw server text|status code/);
      expect(t.length).toBeGreaterThan(10);
    }
    expect(describeSaveError(axiosErr(409))).toMatch(/already/i);
    expect(describeSaveError(new Error("boom"))).not.toMatch(/boom/);
  });

  it("the scan copy constants are closed sentences", () => {
    expect(SCAN_FAILED_COPY).toMatch(/clearer photo/i);
    expect(RECORDS_FAILED_COPY).toMatch(/try again/i);
  });
});
