import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

/**
 * Row 510: the optional body of POST /recurring-invoices/:id/run ("Run now"). Empty on the first press; after a 409
 * RESTRICTION_WARNING the client resubmits with `{ restrictionOverrides, warningHash }`. A scheduled run has no body.
 */
export class RunRecurringInvoiceDto extends RestrictionAckDto {}
