import { HttpException, InternalServerErrorException, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

const logger = new Logger("SendAfterCommit");

/** What the caller already committed before the send step ran. */
export interface KeptDraft {
  invoiceId: string;
  /** Set on the sale path, where the order was committed too. */
  orderId?: string | null;
}

/**
 * Row 466 ("the record lies"): create-and-send commits the draft FIRST, then sends. Any error the
 * send step throws after that commit left the client believing nothing was created, and a retry
 * made a duplicate. This stamps `invoiceId` (and `orderId` on the sale path) onto the error body so
 * every client can open the kept draft, whatever the failure was.
 *
 * - An HttpException keeps its class, status, code and message; only `invoiceId` is merged into its
 *   body.
 * - Anything else becomes a coded 500 (`INVOICE_SEND_AFTER_CREATE_FAILED`) with the original as its
 *   `cause` and in the server log, so Sentry still sees it. The raw message never reaches the body.
 * - The error is always rethrown; this never swallows.
 */
export function withKeptDraft(err: unknown, kept: KeptDraft): HttpException {
  const extra = {
    invoiceId: kept.invoiceId,
    ...(kept.orderId ? { orderId: kept.orderId } : {}),
  };
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const merged =
      typeof body === "string"
        ? { statusCode: err.getStatus(), message: body, ...extra }
        : { ...body, ...extra };
    // Mutate in place so the exception keeps its class (callers and specs match on it).
    (err as unknown as { response: unknown }).response = merged;
    return err;
  }
  logger.error(
    `send failed after invoice ${kept.invoiceId} was committed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
  return new InternalServerErrorException(
    {
      code: API_ERROR_CODES.INVOICE_SEND_AFTER_CREATE_FAILED,
      message: "The invoice was saved as a draft, but it could not be sent. Open it to send it.",
      ...extra,
    },
    { cause: err },
  );
}

/** Run the post-commit send step; any failure carries the kept draft's id. */
export async function sendAfterCommit<T>(kept: KeptDraft, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw withKeptDraft(err, kept);
  }
}
