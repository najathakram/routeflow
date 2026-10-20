import * as React from "react";

/**
 * The right column under Details (K11-23). Not split: one grid item at row 2. Split (prices v2, non-family): the part
 * above the prices region (regulatory, Labels, Portal visibility) at row 2 and the part below it (Units, sales,
 * history, variants) at row 4, with the prices region itself at row 3 (rendered once by the page, right after Details
 * in the DOM so a phone reads and tabs prices before Image and stock). Same 20 px rhythm as space-y-5 either way.
 */
export function ProductLowerColumns({
  split,
  top,
  bottom,
}: {
  split: boolean;
  top: React.ReactNode;
  bottom: React.ReactNode;
}) {
  if (!split) {
    return (
      <div
        data-testid="product-lower-column"
        className="space-y-5 lg:col-span-2 lg:col-start-2 lg:row-start-2"
      >
        {top}
        {bottom}
      </div>
    );
  }
  return (
    <>
      <div
        data-testid="product-lower-column"
        className="space-y-5 lg:col-span-2 lg:col-start-2 lg:row-start-2"
      >
        {top}
      </div>
      <div
        data-testid="product-lower-column-rest"
        className="space-y-5 lg:col-span-2 lg:col-start-2 lg:row-start-4"
      >
        {bottom}
      </div>
    </>
  );
}

const PHONE_QUERY = "(max-width: 639px)";
/** Below Tailwind's `sm`. False on the server and wherever matchMedia is missing, so the DOM order is the wide one. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mql = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mql.matches);
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, []);
  return phone;
}
