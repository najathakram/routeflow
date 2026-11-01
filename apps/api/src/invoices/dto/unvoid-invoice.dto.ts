import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

/**
 * POST /invoices/:id/unvoid. The body is empty on the first call; after a 409 RESTRICTION_WARNING the client resends the
 * same (empty) request plus the acknowledgement (row 460: an unvoid is a new sale of the whole invoice, judged afresh).
 */
export class UnvoidInvoiceDto extends RestrictionAckDto {}
