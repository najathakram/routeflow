import * as React from "react";

/**
 * The ONE behaviour for a search field with a popup list (row 446, W-686, W-758).
 *
 * Close on leave: Tab, or focus moving anywhere outside the popup's own list, closes the popup so it never sits over the
 * next field; focus moving INTO the list keeps it open. A press inside the list keeps focus on the input (Safari never
 * focuses a clicked button, so a blur would close the list before the click lands).
 *
 * Keyboard navigation (opt-in, pass `nav`): ArrowDown / ArrowUp move ONE highlight over the options (ArrowDown opens a
 * closed popup), Enter picks the highlighted option, Escape closes. With nothing highlighted Enter is left alone, so a
 * form's own Enter still works. The mouse shares the highlight (hover sets it), and it resets whenever the popup closes
 * or the option count changes.
 *
 * Spread `inputProps` on the <input>, `listProps` on the popup's list container and `optionProps(i)` on each option:
 *   const leave = useDismissOnLeave(setOpen, { open, count: products.length, onPick: (i) => pick(products[i]) });
 *   <input {...leave.inputProps} />
 *   {open && <ul {...leave.listProps}>{products.map((p, i) => <li {...leave.optionProps(i)} />)}</ul>}
 */
export interface DismissNav {
  open: boolean;
  /** Number of options currently rendered. */
  count: number;
  onPick: (index: number) => void;
}

export function useDismissOnLeave(setOpen: (open: boolean) => void, nav?: DismissNav) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(-1);
  const open = nav?.open ?? false;
  const count = nav?.count ?? 0;

  // the highlight never outlives the popup or the list it pointed into
  React.useEffect(() => {
    setActive(-1);
  }, [open, count]);

  return {
    activeIndex: active,
    inputProps: {
      onBlur: (e: React.FocusEvent) => {
        if (!listRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        // Tab leaves the field: close first, so focus moves to the next field, never into the list
        if (e.key === "Tab") {
          setOpen(false);
          return;
        }
        if (!nav) return;
        if (e.key === "Escape" && open) {
          setOpen(false);
          return;
        }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && count > 0) {
          e.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          setActive((a) =>
            e.key === "ArrowDown" ? Math.min(a + 1, count - 1) : Math.max(a - 1, 0),
          );
          return;
        }
        if (e.key === "Enter" && open && active >= 0 && active < count) {
          e.preventDefault();
          nav.onPick(active);
        }
      },
    },
    listProps: {
      ref: listRef,
      role: "listbox" as const,
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    },
    optionProps: (index: number) => ({
      role: "option" as const,
      "aria-selected": index === active,
      onMouseEnter: () => setActive(index),
      ref: (el: HTMLElement | null) => {
        if (el && index === active) el.scrollIntoView?.({ block: "nearest" });
      },
    }),
  };
}
