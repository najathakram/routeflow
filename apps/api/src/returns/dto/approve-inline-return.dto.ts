import { IsNumber, IsOptional, Min } from "class-validator";

/**
 * Returns Inside Order Creation — PR-1c fix round (Opus review HIGH-3): the controller used
 * to bind this body as a bare `{ amount?: number }` type annotation, which is erased at
 * runtime — `ValidationPipe` never saw a class to validate against, so a non-numeric
 * `amount` (e.g. a JSON `"abc"`, or a value that parses to `NaN`) sailed straight through to
 * the service. There, `roundMoney(NaN)` produces `0`, which passes BOTH of `approve()`'s own
 * guards (`0 >= 0` and `0 <= heldAmount`) — so a garbage body silently APPROVED the hold
 * (clearing it) while minting a credit for $0.00, leaving the customer's goods taken with no
 * credit ever issued. A real DTO class rejects a non-numeric or non-positive `amount` with a
 * 400 before the service ever sees it. `amount: 0` specifically must go through `reject()`
 * instead — approving a zero-dollar credit is never a legitimate "approval".
 */
export class ApproveInlineReturnDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;
}
