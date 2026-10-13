import { unitWords } from "@routeflow/pricing";

const UW = unitWords();

/** Read-only value beside the "pieces per box" label: "12 pcs", or "Sold individually". */
export function PiecesPerBoxValue({ unitsPerBox }: { unitsPerBox: number | string | null }) {
  const n = Number(unitsPerBox);
  if (!(n > 1)) return <>Sold individually</>;
  return (
    <>
      {n} {UW.baseShortFor(n)}
    </>
  );
}
