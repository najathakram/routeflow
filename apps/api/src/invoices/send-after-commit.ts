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
/** Merge `extra` into an HttpException's body in place, so it keeps its class, status and code. */
function mergeIntoBody(err: HttpException, extra: Record<string, unknown>): HttpException {
  const body = err.getResponse();
  const merged =
    typeof body === "string"
      ? { statusCode: err.getStatus(), message: body, ...extra }
      : { ...body, ...extra };
  (err as unknown as { response: unknown }).response = merged;
  return err;
}

export function withKeptDraft(err: unknown, kept: KeptDraft): HttpException {
  const extra = {
    invoiceId: kept.invoiceId,
    ...(kept.orderId ? { orderId: kept.orderId } : {}),
  };
  if (err instanceof HttpException) return mergeIntoBody(err, extra);
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

/**
 * `invoices.send(invoiceId, ...opts)` for a caller that has just committed the invoice (and its
 * order): a failure carries both ids. A one-line call site for OrdersService, which is at its size cap.
 */
export function sendCommitted<A extends unknown[], T>(
  invoices: { send(id: string, ...opts: A): Promise<T> },
  invoiceId: string,
  orderId: string,
  ...opts: A
): Promise<T> {
  return sendAfterCommit({ invoiceId, orderId }, () => invoices.send(invoiceId, ...opts));
}

/**
 * Row 466 (sale path): createSale commits the ORDER first, then builds its invoice. When the invoice
 * step throws, the error carries `orderId` so the client opens the order instead of retrying into a
 * duplicate sale. An HttpException keeps its class, status, code and message (and any `invoiceId` it
 * already carries); anything else becomes a coded 500 with a fixed message, `cause` kept and logged.
 */
export function withKeptOrder(err: unknown, orderId: string): HttpException {
  if (err instanceof HttpException) return mergeIntoBody(err, { orderId });
  logger.error(
    `invoice step failed after order ${orderId} was committed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
  return saleInvoiceFailed(orderId, err);
}

/** The coded 500 for "the order exists, its invoice does not". */
export function saleInvoiceFailed(orderId: string, cause?: unknown): InternalServerErrorException {
  return new InternalServerErrorException(
    {
      code: API_ERROR_CODES.SALE_INVOICE_CREATE_FAILED,
      message:
        "The order was created but its invoice could not be generated. Open the order and use “Generate Invoice”.",
      orderId,
    },
    cause === undefined ? undefined : { cause },
  );
}
