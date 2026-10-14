import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  EditActionButtons,
  EditButton,
  StickyEditBar,
  scrollCardIntoView,
} from "./ProductEditActions";

describe("EditButton (P-01)", () => {
  it("is a button named Edit with a visible word, keeping the e2e title hook", () => {
    const onClick = jest.fn();
    render(<EditButton onClick={onClick} />);
    const b = screen.getByRole("button", { name: "Edit" });
    expect(b).toHaveTextContent("Edit");
    expect(b).toHaveAttribute("title", "Edit product");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("EditActionButtons (P-01)", () => {
  it("Cancel then Save, both with words", () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();
    render(<EditActionButtons onCancel={onCancel} onSave={onSave} saving={false} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("StickyEditBar (P-02)", () => {
  it("is a fixed bottom bar shown below md only, with the same Cancel / Save", () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();
    render(<StickyEditBar onCancel={onCancel} onSave={onSave} saving={false} />);
    const bar = screen.getByTestId("sticky-edit-bar");
    expect(bar.className).toMatch(/\bfixed\b/);
    expect(bar.className).toMatch(/\bbottom-0\b/);
    expect(bar.className).toMatch(/\bmd:hidden\b/);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("buttons are 44px tall", () => {
    render(<StickyEditBar onCancel={jest.fn()} onSave={jest.fn()} saving={false} />);
    for (const b of screen.getAllByRole("button")) expect(b.className).toMatch(/min-h-11/);
  });
});

describe("scrollCardIntoView (P-17)", () => {
  const setMatch = (reduce: boolean) => {
    window.matchMedia = jest.fn().mockImplementation((q: string) => ({
      matches: reduce && q.includes("prefers-reduced-motion"),
      media: q,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
  };

  it("scrolls the card smoothly to nearest", () => {
    setMatch(false);
    const el = { scrollIntoView: jest.fn() } as unknown as HTMLElement;
    scrollCardIntoView(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
  });

  it("jumps (no smooth scroll) under reduced motion", () => {
    setMatch(true);
    const el = { scrollIntoView: jest.fn() } as unknown as HTMLElement;
    scrollCardIntoView(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
  });

  it("tolerates a missing element", () => {
    expect(() => scrollCardIntoView(null)).not.toThrow();
  });
});
