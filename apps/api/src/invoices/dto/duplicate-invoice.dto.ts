import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

/**
 * POST /invoices/:id/duplicate. The body is empty on the first call; after a 409 RESTRICTION_WARNING the client resends
 * the same (empty) request plus the acknowledgement (row 510: a duplicate is a new sale and is judged afresh).
 */
export class DuplicateInvoiceDto extends RestrictionAckDto {}
