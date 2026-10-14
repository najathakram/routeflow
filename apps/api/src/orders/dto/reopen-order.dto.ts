import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

/**
 * POST /orders/:id/reopen. The body is empty on the first call; after a 409 RESTRICTION_WARNING the client resends the
 * same request plus the acknowledgement (row 510: a reopened order puts every line back on sale).
 */
export class ReopenOrderDto extends RestrictionAckDto {}
