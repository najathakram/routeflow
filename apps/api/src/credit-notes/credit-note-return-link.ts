/**
 * SA-773 row 333(a): the link between a return and the credit note minted for it (`Return.creditNoteId`) is written by a CAS
 * inside the mint transaction, and a retry that finds it set gets that credit note back instead of a second mint.
 */
import { ConflictException } from "@nestjs/common";

/** The credit note a return already points at (with the customer summary a create() answers with), else null. */
export async function creditNoteLinkedToReturn(db: any, returnId: string): Promise<any | null> {
  const ret: { creditNoteId?: string | null } | null =
    (await db.return?.findFirst?.({ where: { id: returnId }, select: { creditNoteId: true } })) ??
    null;
  if (!ret?.creditNoteId) return null;
  return (
    (await db.creditNote?.findFirst?.({
      where: { id: ret.creditNoteId },
      include: { customer: { select: { id: true, businessName: true } } },
    })) ?? null
  );
}

/** Thrown inside the mint transaction when the link CAS matched nothing: the insert rolls back with it. */
export class ReturnLinkLost extends Error {
  constructor() {
    super("The return was linked to a credit note by another request");
  }
}

export const returnLinkConflict = (): ConflictException =>
  new ConflictException(
    "This return's credit note is being issued by another request. Please retry.",
  );
