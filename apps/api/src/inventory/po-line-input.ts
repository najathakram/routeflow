import { BadRequestException } from "@nestjs/common";
import { buildPOLine, type POLineAmounts } from "@routeflow/pricing";

/**
 * One PO line as a client sends it, turned into the stored amounts through the ONE pricing builder
 * (`buildPOLine`). A line that carries `caseCost` was entered PER CASE: `packSize`, `caseCost`, `cases` and
 * optional `loosePieces` are the entered figures and the server computes quantity, per-piece cost and the exact
 * total from them, ignoring any `qty` / `qtyOrdered` / `unitCost` / `totalCost` the client also sent. Without
 * `caseCost` the line is per piece (`qty` or `qtyOrdered`, and `unitCost`), exactly as before.
 * An input no valid line can have is a 400.
 */
export function poLineFromInput(raw: {
  caseCost?: unknown;
  packSize?: unknown;
  cases?: unknown;
  loosePieces?: unknown;
  qty?: unknown;
  qtyOrdered?: unknown;
  unitCost?: unknown;
}): POLineAmounts {
  try {
    if (raw.caseCost != null) {
      return buildPOLine({
        packSize: Number(raw.packSize),
        caseCost: Number(raw.caseCost),
        cases: Number(raw.cases ?? 0),
        loosePieces: Number(raw.loosePieces ?? 0),
      });
    }
    return buildPOLine({
      qtyOrdered: Number(raw.qtyOrdered ?? raw.qty),
      unitCost: Number(raw.unitCost),
    });
  } catch (e) {
    if (e instanceof RangeError) throw new BadRequestException(e.message);
    throw e;
  }
}
