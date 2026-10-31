import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { TOUCH_FIRST_QUERY } from "@/lib/touch-first";
import { renderTill } from "@/test-utils/render-till";
import { AnchoredPopover } from "@/components/AnchoredPopover";
import { CounterSaleScreen } from "./CounterSaleScreen";
import { cameraFrameBlocked, counterDialogOpen } from "./counter-scan-guard";

/**
 * W-1042 MUST 14b (SA-1062 A-1): the camera also stops for a menu or popover. `counterDialogOpen()` needs
 * `data-state="open"`, so the phone menu drawer (a plain `role="dialog"`) and `AnchoredPopover` (the same, and the shape of
 * W-853's price history panel) did not hold a frame back. The camera check reads any dialog that is not `closed`; the shared
 * `counterDialogOpen()` is NOT widened, so a desktop till's wedge scan still lands with a popover open. The popover here is
 * the REAL `AnchoredPopover`; the drawer is the element layout.tsx renders (role, aria-modal, label, no data-state).
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
const strip: { frameBlocked: (() => boolean) | null } = { frameBlocked: null };
jest.mock("./CounterCameraStrip", () => ({
  ...jest.requireActual("./CounterCameraStrip"),
  CounterCameraStrip: (props: { frameBlocked: () => boolean }) => {
    strip.frameBlocked = props.frameBlocked;
    return <div data-testid="counter-camera-strip" />;
  },
}));

const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  sku: "200000000001",
  pricePerUnit: 2.5,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
};

function setTouchFirst(on: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: on && q === TOUCH_FIRST_QUERY,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  strip.frameBlocked = null;
  (apiClient.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url.startsWith("/products/barcode/")) {
      return decodeURIComponent(url.slice("/products/barcode/".length)) === COLA.sku
        ? { data: COLA }
        : Promise.reject({ response: { status: 404 } });
    }
    if (url === "/products") return { data: { data: [] } };
    throw new Error(`unexpected GET ${url}`);
  });
  setTouchFirst(true);
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

/** The real popover, anchored to a real button, as W-853's price history panel is. */
function Popover() {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  return (
    <>
      <button ref={setAnchor}>Price history</button>
      {anchor ? (
        <AnchoredPopover anchor={anchor} onClose={() => undefined} label="Price history">
          <p>History</p>
        </AnchoredPopover>
      ) : null}
    </>
  );
}

function Drawer() {
  return (
    <div role="dialog" aria-modal="true" aria-label="Navigation">
      <button>Orders</button>
    </div>
  );
}

describe("W-1042 MUST 14b: the camera stops for a menu or popover", () => {
  it("R13c: the phone menu drawer open, a code in frame: the camera drops it", () => {
    renderTill(
      <>
        <CounterSaleScreen />
        <Drawer />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(strip.frameBlocked).not.toBeNull();
    expect(strip.frameBlocked!()).toBe(true);
  });

  it("R13c: a real AnchoredPopover open (W-853's price history is one): the camera drops the frame", () => {
    renderTill(
      <>
        <CounterSaleScreen />
        <Popover />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(screen.getByRole("dialog", { name: "Price history" })).toBeInTheDocument();
    expect(strip.frameBlocked!()).toBe(true);
  });

  it("R13d: nothing open, a code in frame: the camera lets it through", () => {
    renderTill(<CounterSaleScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(strip.frameBlocked!()).toBe(false);
  });

  it("R13d: a dialog that is closed (Radix leaves one mounted) does not deafen the camera", () => {
    renderTill(
      <>
        <CounterSaleScreen />
        <div role="dialog" data-state="closed" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(strip.frameBlocked!()).toBe(false);
  });

  it("R13e guard: counterDialogOpen() is NOT widened: false with a real popover open, so the key listener is not deaf", () => {
    renderTill(
      <>
        <CounterSaleScreen />
        <Popover />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Price history" })).toBeInTheDocument();
    expect(counterDialogOpen()).toBe(false);
    expect(cameraFrameBlocked(null)).toBe(true);
  });

  it("R13e guard: desktop till, popover open, focus on it, a wedge scan still lands as at master", async () => {
    setTouchFirst(false);
    renderTill(
      <>
        <CounterSaleScreen />
        <Popover />
      </>,
    );
    const popover = screen.getByRole("dialog", { name: "Price history" });
    act(() => popover.focus());
    await userEvent.keyboard("200000000001{Enter}");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
  });
});
