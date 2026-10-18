import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductHeaderControls } from "./ProductHeaderControls";

let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));

const flow = () => ({ start: jest.fn(), askDeactivate: jest.fn(), isPending: false });

function setup(
  over: {
    isActive?: boolean;
    kind?: string;
    tobaccoAddon?: boolean;
    isTobacco?: boolean;
    tobaccoLoading?: boolean;
    flowPending?: boolean;
  } = {},
) {
  const reactivateFlow = { ...flow(), isPending: over.flowPending ?? false };
  const onRequestDelete = jest.fn();
  const onToggleTobacco = jest.fn();
  const onMakeVariant = jest.fn();
  render(
    <ProductHeaderControls
      product={{
        id: "p1",
        name: "Cola 12pk",
        isActive: over.isActive ?? true,
        parentProductId: null,
        kind: over.kind ?? "SIMPLE",
      }}
      reactivateFlow={reactivateFlow}
      hasTobaccoAddon={over.tobaccoAddon ?? false}
      isTobacco={over.isTobacco ?? false}
      tobaccoLoading={over.tobaccoLoading ?? false}
      onToggleTobacco={onToggleTobacco}
      onMakeVariant={onMakeVariant}
      onRequestDelete={onRequestDelete}
    />,
  );
  return { reactivateFlow, onRequestDelete, onToggleTobacco, onMakeVariant };
}

beforeEach(() => {
  role = "OPERATOR";
});

describe("ProductHeaderControls (VU-2)", () => {
  it("an inactive product offers Reactivate, never Activate", () => {
    setup({ isActive: false });
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("an active product offers Deactivate", () => {
    setup();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
  });

  it("Reactivate starts the same flow; Deactivate asks first (unchanged)", () => {
    const a = setup({ isActive: false });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    expect(a.reactivateFlow.start).toHaveBeenCalledWith("p1", "product", "Cola 12pk");
    expect(a.reactivateFlow.askDeactivate).not.toHaveBeenCalled();
  });

  it("Deactivate opens the deactivate confirm path", () => {
    const a = setup();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(a.reactivateFlow.askDeactivate).toHaveBeenCalledWith("p1", "Cola 12pk");
    expect(a.reactivateFlow.start).not.toHaveBeenCalled();
  });

  it("Delete is an OPERATOR control in the lighter danger-outline style", () => {
    setup();
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del.className).toContain("border-danger/40");
    expect(del.className).toContain("text-danger");
    expect(del.className).not.toContain("bg-danger ");
  });

  it.each(["DRIVER", "CUSTOMER", "STAFF"])("Delete and Make variant of… are absent for %s", (r) => {
    role = r;
    setup();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make variant of…" })).toBeNull();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])(
    "owner ruling 2026-10-14: %s gets Delete and Make variant of…",
    (r) => {
      role = r;
      setup();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Make variant of…" })).toBeEnabled();
    },
  );

  it("Delete asks the page to open its DeleteProductConfirm (no second dialog here)", () => {
    const { onRequestDelete } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("P-14: secondary actions are ghost; Delete sits apart behind a divider wrapper from sm up", () => {
    setup();
    const deactivate = screen.getByRole("button", { name: "Deactivate" });
    expect(deactivate.className).not.toMatch(/border-line-strong/); // not the secondary look
    expect(deactivate.className).toMatch(/text-ink-500/); // ghost
    const del = screen.getByRole("button", { name: "Delete" });
    const wrap = del.parentElement as HTMLElement;
    expect(wrap.className).toMatch(/sm:border-l/);
    expect(wrap.className).toMatch(/sm:ml-2/);
  });
});

/** Opens the "More actions" menu from the keyboard (Radix opens on Enter), as a phone user's switch or keyboard would. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: "More actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  return { trigger, menu: await screen.findByRole("menu") };
}

describe("K11-22: header actions in one More menu below sm", () => {
  it("the trigger is an icon-only 44px target named More actions, shown below sm only", () => {
    setup({ tobaccoAddon: true });
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger.textContent?.trim()).toBe("");
    expect(trigger.className).toMatch(/min-h-\[44px\]/);
    expect(trigger.className).toMatch(/min-w-\[44px\]/);
    expect(trigger.className).not.toMatch(/\bborder\b/);
    expect((trigger.parentElement as HTMLElement).className).toMatch(/sm:hidden/);
  });

  it("every button action is hidden below sm (CSS, not a JS width hook) and still there from sm up", () => {
    setup({ tobaccoAddon: true });
    for (const name of ["Make variant of…", "Deactivate", "Mark as tobacco"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/max-sm:hidden/);
    }
    const wrap = screen.getByRole("button", { name: "Delete" }).parentElement as HTMLElement;
    expect(wrap.className).toMatch(/max-sm:hidden/);
    expect(wrap.className).not.toMatch(/max-sm:basis-full/);
  });

  it("the menu lists the same actions in today's order, Delete last behind a separator", async () => {
    const user = userEvent.setup();
    setup({ tobaccoAddon: true });
    const { menu } = await openMenu(user);
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent?.trim());
    expect(names).toEqual(["Make variant of…", "Deactivate", "Mark as tobacco", "Delete"]);
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    const del = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(del.className).toMatch(/text-danger/);
  });

  it("parity: every action exists twice, once as a button (sm up) and once as a menu item", async () => {
    const user = userEvent.setup();
    setup({ tobaccoAddon: true });
    const names = ["Make variant of…", "Deactivate", "Mark as tobacco", "Delete"];
    // an open menu hides the page behind it from the accessibility tree, so count the buttons first
    for (const name of names) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    const { menu } = await openMenu(user);
    for (const name of names) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("an inactive product's menu offers Reactivate and an on tobacco product offers Unmark tobacco", async () => {
    const user = userEvent.setup();
    setup({ isActive: false, tobaccoAddon: true, isTobacco: true });
    const { menu } = await openMenu(user);
    expect(within(menu).getByRole("menuitem", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Unmark tobacco" })).toBeInTheDocument();
  });

  it("each menu item calls the same handler its button does", async () => {
    const user = userEvent.setup();
    const a = setup({ tobaccoAddon: true });
    let { menu } = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Make variant of…" }));
    await waitFor(() => expect(a.onMakeVariant).toHaveBeenCalledTimes(1));
    ({ menu } = await openMenu(user));
    await user.click(within(menu).getByRole("menuitem", { name: "Deactivate" }));
    await waitFor(() =>
      expect(a.reactivateFlow.askDeactivate).toHaveBeenCalledWith("p1", "Cola 12pk"),
    );
    ({ menu } = await openMenu(user));
    await user.click(within(menu).getByRole("menuitem", { name: "Mark as tobacco" }));
    await waitFor(() => expect(a.onToggleTobacco).toHaveBeenCalledTimes(1));
  });

  it("Reactivate from the menu starts the reactivate flow", async () => {
    const user = userEvent.setup();
    const a = setup({ isActive: false });
    const { menu } = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Reactivate" }));
    await waitFor(() =>
      expect(a.reactivateFlow.start).toHaveBeenCalledWith("p1", "product", "Cola 12pk"),
    );
  });

  it("Delete from the menu opens the page's confirm after the menu closes, with focus parked on the trigger", async () => {
    const user = userEvent.setup();
    const a = setup();
    const { trigger, menu } = await openMenu(user);
    let focusAtOpen: Element | null = null;
    a.onRequestDelete.mockImplementation(() => {
      focusAtOpen = document.activeElement;
    });
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(a.onRequestDelete).toHaveBeenCalledTimes(1));
    // The confirm opens from the trigger, so Cancel puts focus back on the three dots (Radix returns to what had focus).
    expect(focusAtOpen).toBe(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("while a deactivate or tobacco write is pending the trigger shows busy and that item is disabled", async () => {
    const user = userEvent.setup();
    setup({ tobaccoAddon: true, flowPending: true });
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveAttribute("aria-busy", "true");
    const { menu } = await openMenu(user);
    expect(within(menu).getByRole("menuitem", { name: "Deactivate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: "Mark as tobacco" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("a tobacco write in flight disables the tobacco item only", async () => {
    const user = userEvent.setup();
    setup({ tobaccoAddon: true, tobaccoLoading: true });
    expect(screen.getByRole("button", { name: "More actions" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    const { menu } = await openMenu(user);
    expect(within(menu).getByRole("menuitem", { name: "Mark as tobacco" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("no menu holds a single item: a non-staff family's lone Deactivate stays a plain button at every width", () => {
    role = "STAFF";
    setup({ kind: "FAMILY" });
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    const only = screen.getByRole("button", { name: "Deactivate" });
    expect(only.className).not.toMatch(/max-sm:hidden/);
  });
});

describe("K11-22: focus returns after the delete confirm", () => {
  /** A page stand-in: opening sets deleteOpen, and a button outside plays the confirm's Cancel. */
  function Host() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <ProductHeaderControls
          product={{
            id: "p1",
            name: "Cola 12pk",
            isActive: true,
            parentProductId: null,
            kind: "SIMPLE",
          }}
          reactivateFlow={flow()}
          hasTobaccoAddon={false}
          isTobacco={false}
          tobaccoLoading={false}
          onToggleTobacco={jest.fn()}
          onMakeVariant={jest.fn()}
          onRequestDelete={() => setOpen(true)}
          deleteOpen={open}
        />
        <button type="button" onClick={() => setOpen(false)}>
          Fake cancel
        </button>
      </>
    );
  }

  it("Delete from the menu, then Cancel: focus is back on the More actions trigger", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    // the confirm is open; Radix's Dialog returns focus only to a Dialog.Trigger (none here), so focus is lost
    await user.click(await screen.findByRole("button", { name: "Fake cancel", hidden: true }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("Delete from the button (sm and up), then Cancel: focus is back on the Delete button", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const del = screen.getByRole("button", { name: "Delete" });
    await user.click(del);
    await user.click(screen.getByRole("button", { name: "Fake cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(del));
  });
});
