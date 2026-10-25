import { unitWords } from "@routeflow/pricing";

const UW = unitWords();

/** Read-only value beside the "pieces per box" label: "12 pcs", or "Sold individually"; a family has no value of its own ("Set per variant"). */
export function PiecesPerBoxValue({
  unitsPerBox,
  isFamily = false,
}: {
  unitsPerBox: number | string | null;
  isFamily?: boolean;
}) {
  if (isFamily) return <>Set per variant</>;
  const n = Number(unitsPerBox);
  if (!(n > 1)) return <>Sold individually</>;
  return (
    <>
      {n} {UW.baseShortFor(n)}
    </>
  );
}
