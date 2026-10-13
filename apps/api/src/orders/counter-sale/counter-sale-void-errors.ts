import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * SA-762r: the four refusals of POST /orders/counter-sale/:orderId/void that have a code of their own. Each is
 * raised BEFORE any write (or under the void's lock with the transaction rolling back), so a refusal never leaves a
 * half-voided sale. The copy is what the clerk reads; the code is what the clients branch on.
 */
export const counterVoidBusy = () =>
  new ServiceUnavailableException({
    code: API_ERROR_CODES.COUNTER_SALE_VOID_BUSY,
    message:
      "This sale is being updated at the register right now. Try voiding it again in a moment.",
  });

export const counterVoidHasReturn = () =>
  new ConflictException({
    code: API_ERROR_CODES.COUNTER_SALE_VOID_HAS_RETURN,
    message:
      "A return was recorded against this sale. Reverse the return in the office before voiding it.",
  });

export const counterVoidForeignPayment = () =>
  new ConflictException({
    code: API_ERROR_CODES.COUNTER_SALE_VOID_FOREIGN_PAYMENT,
    message:
      "This sale holds a payment the register did not take (store credit, an advance, an office payment or a deposited check). The office must reverse it before the sale can be voided.",
  });

export const counterVoidNotToday = () =>
  new ConflictException({
    code: API_ERROR_CODES.COUNTER_SALE_VOID_NOT_TODAY,
    message:
      "Only a sale rung today can be voided at the register. Ask the office to handle this one.",
  });
