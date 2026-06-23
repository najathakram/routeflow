import { IsOptional, IsString, MaxLength } from "class-validator";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * Carrier shipment tracking for an order that ships via a carrier instead of our
 * own route. Both fields are optional: sending an empty string clears the value
 * (and clearing the tracking number also clears `shippedAt`). The order's values
 * are mirrored onto its non-void invoices so the shipment shows on the invoice.
 */
export class UpdateShipmentDto {
  /** Carrier label — UPS/FedEx/USPS/DHL/Other, or any custom courier name. */
  @IsOptional() @IsString() @MaxLength(64) @StripHtml() shippingCarrier?: string;
  /** Tracking number from the carrier. */
  @IsOptional() @IsString() @MaxLength(128) @StripHtml() shippingTrackingNumber?: string;
}
