import { Injectable } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { PolicyOversellReader } from "./policy-oversell-reader";
import { getStockAvailability } from "./stock-availability";

/**
 * Live stock per line (read-only): `Product.currentStock` + the save path's own oversell resolution.
 * A service of its own (not an OrdersService method): orders.service.ts sits at its size-ratchet cap.
 */
@Injectable()
export class StockAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly oversellReader: PolicyOversellReader,
  ) {}

  get(productIds: string[], user: JwtPayload, mode: "entry" | "edit", customerId?: string | null) {
    return getStockAvailability({
      productIds,
      user: { tenantId: (user.tenantId ?? this.prisma.getTenantId()) as string, role: user.role },
      mode,
      customerId,
      products: this.prisma.forTenant().product,
      oversellReader: this.oversellReader,
    });
  }
}
