import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { useGuardedSignOut } from "./SignOutUnsentGuard";
import { createDraftMirror } from "@/lib/order-draft/mirror";
import { createMemoryDraftStorage, setDraftMirrorStorage } from "@/lib/order-draft/storage";
import type { DraftMirrorStorage } from "@/lib/order-draft/storage";

// SA-817 (A) 6 / A8: an explicit sign-out with unsent work asks first ("You have 1 unsent order on this device"); a session
// expiry never comes through this guard, so it never asks and never touches the local copy.

const user = { id: "u1", tenantId: "t1" };

function Host({ signOut, who = user }: { signOut: () => void; who?: typeof user }) {
  const { requestSignOut, dialog } = useGuardedSignOut(signOut, who);
  return (
    <>
      <button onClick={requestSignOut}>Sign out</button>
      {dialog}
    </>
  );
}

async function seed(
  storage: DraftMirrorStorage,
  tenantId: string,
  userId: string,
  localId: string,
) {
  const mirror = createDraftMirror({ storage, tenantId, userId });
  mirror.write({
    localId,
    serverDraftId: null,
    serverUpdatedAt: null,
    syncedHash: null,
    customerId: "c1",
    customerName: "Acme",
    payload: {
      customer: { id: "c1", businessName: "Acme" },
      lineItems: [{ tempId: "t1", productId: "p1", qty: 1 }],
      _submitKey: "K-1",
    } as never,
  });
  await mirror.flush();
}

describe("sign-out with unsent work (SA-817 A8)", () => {
  let storage: ReturnType<typeof createMemoryDraftStorage>;
  beforeEach(() => {
    storage = createMemoryDraftStorage();
    setDraftMirrorStorage(storage);
  });
  afterEach(() => setDraftMirrorStorage(null));

  it("A8: with an unsent order, Sign out asks first and signs out only on 'Sign out anyway'", async () => {
    await seed(storage, "t1", "u1", "L1");
    const signOut = jest.fn();
    const ui = userEvent.setup({ delay: null });
    renderWithProviders(<Host signOut={signOut} />);

    await ui.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/You have 1 unsent order on this device/)).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();

    await ui.click(screen.getByRole("button", { name: "Sign out anyway" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    // signing out never deletes the local copy: the same user finds it at the next sign-in
    expect(await storage.list("rf:draft:t1:u1:")).toHaveLength(1);
  });

  it("A8: 'Stay signed in' signs nobody out and keeps the copy", async () => {
    await seed(storage, "t1", "u1", "L1");
    const signOut = jest.fn();
    const ui = userEvent.setup({ delay: null });
    renderWithProviders(<Host signOut={signOut} />);
    await ui.click(screen.getByRole("button", { name: "Sign out" }));
    await ui.click(await screen.findByRole("button", { name: "Stay signed in" }));
    await waitFor(() => expect(screen.queryByText(/unsent order/)).not.toBeInTheDocument());
    expect(signOut).not.toHaveBeenCalled();
    expect(await storage.list("rf:draft:t1:u1:")).toHaveLength(1);
  });

  it("A8: with nothing unsent, Sign out signs out at once, no dialog", async () => {
    const signOut = jest.fn();
    const ui = userEvent.setup({ delay: null });
    renderWithProviders(<Host signOut={signOut} />);
    await ui.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/unsent order/)).not.toBeInTheDocument();
  });

  it("A7/A8: another user's or tenant's unsent order on this browser is not this user's to confirm", async () => {
    await seed(storage, "t1", "u2", "L2");
    await seed(storage, "t2", "u1", "L3");
    const signOut = jest.fn();
    const ui = userEvent.setup({ delay: null });
    renderWithProviders(<Host signOut={signOut} />);
    await ui.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("A8: a session expiry keeps the local copy - auth.ts and the cross-tab handler never touch the draft mirror", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path") as typeof import("path");
    for (const file of ["../lib/auth.ts", "../lib/auth-context.tsx"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src).not.toMatch(/order-draft/);
      expect(src).not.toMatch(/indexedDB/i);
    }
  });
});
