import { IsOptional, IsString, MaxLength } from "class-validator";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { Trim } from "../../common/transforms/trim.transform";
import { MAX_SHIPPING_CARRIER, MAX_SHIPPING_TRACKING } from "../shipment-text";

/**
 * Carrier shipment tracking for an order that ships via a carrier instead of our
 * own route. Both fields are optional: sending an empty string clears the value
 * (and clearing the tracking number also clears `shippedAt`). The order's values
 * are mirrored onto its non-void invoices so the shipment shows on the invoice. Both are trimmed, then capped;
 * the service refuses a formula-led changed value (`resolveShipmentText`, row 507).
 */
export class UpdateShipmentDto {
  /** Carrier label — UPS/FedEx/USPS/DHL/Other, or any custom courier name. */
  @IsOptional()
  @IsString()
  @StripHtml()
  @Trim()
  @MaxLength(MAX_SHIPPING_CARRIER)
  shippingCarrier?: string;
  /** Tracking number from the carrier. */
  @IsOptional()
  @IsString()
  @StripHtml()
  @Trim()
  @MaxLength(MAX_SHIPPING_TRACKING)
  shippingTrackingNumber?: string;
}
