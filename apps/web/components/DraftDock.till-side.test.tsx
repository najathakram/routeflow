import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * SA-1066 F9: the dock sat bottom-left, over the till's last lines. On the till route only, from md up, the wrapper
 * moves to the right (`md:left-auto md:right-4`). Below md and on every other route it is exactly as it was. jsdom has no
 * layout, so this pins the classes; the real position is browser-proved at 390 / 768 / 1440.
 */
let mockPathname = "/orders";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => mockPathname,
}));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({
    data: [
      {
        id: "d1",
        kind: "ORDER",
        title: null,
        customerName: "Cust d1",
        payload: { lineItems: [{ productId: "p1" }] },
        updatedAt: new Date().toISOString(),
      },
    ],
  }),
  useDeleteDraft: () => ({ mutate: jest.fn(), isPending: false }),
}));

const dock = () => {
  render(
    <ToastProvider>
      <DraftDock />
    </ToastProvider>,
  );
  return screen.getByRole("button", { name: "Resume" }).closest("div.absolute") as HTMLElement;
};
afterEach(cleanup);

describe("DraftDock side on the till (SA-1066 F9)", () => {
  it("on /orders/counter-sale the wrapper moves right from md up and keeps bottom-left below md", () => {
    mockPathname = "/orders/counter-sale";
    const cls = dock().className;
    expect(cls).toMatch(/(^|\s)md:left-auto(\s|$)/);
    expect(cls).toMatch(/(^|\s)md:right-4(\s|$)/);
    expect(cls).toMatch(/(^|\s)left-4(\s|$)/);
    expect(cls).toMatch(/(^|\s)bottom-24(\s|$)/);
  });

  it("guard: on another route the wrapper has no right-side classes", () => {
    mockPathname = "/orders";
    const cls = dock().className;
    expect(cls).not.toMatch(/md:left-auto|md:right-4/);
    expect(cls).toMatch(/(^|\s)left-4(\s|$)/);
  });
});
