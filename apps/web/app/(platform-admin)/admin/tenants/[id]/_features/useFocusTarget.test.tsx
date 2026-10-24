import * as React from "react";
import { render, waitFor, act } from "@testing-library/react";
import { useFocusTarget } from "./useFocusTarget";

let mockSearch = "";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

/** Puts the browser URL and the mocked router search in step, as a client navigation does. */
function navigateTo(search: string) {
  mockSearch = search;
  window.history.replaceState({ n: search }, "", `/admin/tenants/t-1${search ? `?${search}` : ""}`);
}

/** The page shape: a `<main>` scroller holding the target, which may mount late. */
function WithRef({
  delayMs = 0,
  focusKey = "admin-account",
}: {
  delayMs?: number;
  focusKey?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [shown, setShown] = React.useState(delayMs === 0);
  React.useEffect(() => {
    if (delayMs === 0) return;
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
  useFocusTarget(focusKey, ref);
  return (
    <main data-testid="main">
      {shown && (
        <div ref={ref} tabIndex={-1} data-testid="target">
          Admin Account
        </div>
      )}
    </main>
  );
}

function WithAttribute() {
  useFocusTarget("capabilities");
  return (
    <main data-testid="main">
      <fieldset>
        <input data-focus-target="capabilities" aria-label="First tick" />
      </fieldset>
    </main>
  );
}

function stubMainScroll(main: HTMLElement) {
  const scrollTo = jest.fn();
  Object.defineProperty(main, "scrollTo", { value: scrollTo, configurable: true });
  return scrollTo;
}

beforeEach(() => {
  navigateTo("");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {} }),
  });
});

describe("useFocusTarget (BO-02)", () => {
  it("focuses an element that mounts after a delay, scrolls <main>, then drops ?focus= from the URL", async () => {
    navigateTo("tab=overview&focus=admin-account");
    const view = render(<WithRef delayMs={150} />);
    const main = view.getByTestId("main");
    const scrollTo = stubMainScroll(main);
    const target = await view.findByTestId("target");
    await waitFor(() => expect(target).toHaveFocus());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    // only `focus` goes; other params stay
    await waitFor(() => expect(window.location.search).toBe("?tab=overview"));
  });

  it("an element already on the page is focused at once", async () => {
    navigateTo("focus=admin-account");
    const view = render(<WithRef />);
    expect(await view.findByTestId("target")).toHaveFocus();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("re-triggers when ?focus= changes later, with no remount", async () => {
    navigateTo("focus=admin-account");
    const view = render(<WithRef />);
    const target = await view.findByTestId("target");
    await waitFor(() => expect(target).toHaveFocus());
    // the router reports the cleared URL, the admin clicks elsewhere, then follows the link again
    navigateTo("");
    view.rerender(<WithRef />);
    (target as HTMLElement).blur();
    expect(target).not.toHaveFocus();
    const scrollTo = stubMainScroll(view.getByTestId("main"));
    navigateTo("tab=overview&focus=admin-account");
    view.rerender(<WithRef />);
    await waitFor(() => expect(target).toHaveFocus());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?tab=overview");
  });

  it("does nothing for another key and leaves the URL alone", async () => {
    navigateTo("focus=capabilities");
    const view = render(<WithRef />);
    const target = await view.findByTestId("target");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(target).not.toHaveFocus();
    expect(window.location.search).toBe("?focus=capabilities");
  });

  it("finds a [data-focus-target] element when no ref is given", async () => {
    navigateTo("focus=capabilities");
    const view = render(<WithAttribute />);
    const input = view.getByLabelText("First tick");
    await waitFor(() => expect(input).toHaveFocus());
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("uses a non-smooth scroll under prefers-reduced-motion", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({ matches: true, media: q, addListener() {}, removeListener() {} }),
    });
    navigateTo("focus=admin-account");
    const view = render(<WithRef delayMs={50} />);
    const scrollTo = stubMainScroll(view.getByTestId("main"));
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });
});
