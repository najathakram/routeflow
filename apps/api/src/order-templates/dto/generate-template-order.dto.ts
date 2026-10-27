import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

/**
 * Row 510: the optional body of POST /order-templates/:id/generate (staff "Generate", and a buyer's own Reorder, which
 * ignores it). Empty on the first press; after a 409 RESTRICTION_WARNING a STAFF caller resubmits with
 * `{ restrictionOverrides, warningHash }`. The scheduled 06:00 run has no body and never stamps.
 */
export class GenerateTemplateOrderDto extends RestrictionAckDto {}
