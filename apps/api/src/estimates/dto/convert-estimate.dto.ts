import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";

/**
 * POST /estimates/:id/convert(-to-invoice). The body is empty on the first call; after a 409 RESTRICTION_WARNING the
 * client resends the same request plus the acknowledgement (row 510: a conversion is a sale, judged now).
 */
export class ConvertEstimateDto extends RestrictionAckDto {}
