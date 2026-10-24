import { renderWithProviders } from "@/test-utils/render";
import { OP_KEYS } from "./auth-keys";
import {
  invoiceDraftKey,
  resumeInvoiceDraftWrites,
  writeInvoiceDraft,
} from "./invoice-draft-storage";

const form = {
  basis: "standalone",
  customer: { id: "c-1", businessName: "Acme Co" },
  lines: [],
};

describe("signed out in another tab (ROW 447)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    resumeInvoiceDraftWrites();
    jest.restoreAllMocks();
  });

  it("wipes the drafts and a late flush cannot write one back", () => {
    const key = invoiceDraftKey("acme", "u1");
    expect(writeInvoiceDraft(key, form)).toBe(true);
    renderWithProviders(<div />);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: OP_KEYS.accessToken,
        newValue: null,
        storageArea: window.localStorage,
      }),
    );
    expect(window.localStorage.getItem(key!)).toBeNull();
    expect(writeInvoiceDraft(key, form)).toBe(false);
  });

  it("wipes the day-close count drafts kept for this tab (R7b 2.3)", () => {
    const key = "rf:dayclose:draft:acme:main:2026-10-07";
    window.sessionStorage.setItem(key, JSON.stringify({ v: 1 }));
    renderWithProviders(<div />);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: OP_KEYS.accessToken,
        newValue: null,
        storageArea: window.localStorage,
      }),
    );
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });
});
