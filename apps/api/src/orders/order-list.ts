import { ForbiddenException } from "@nestjs/common";
import { ChangeRequestStatus, UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import { ordersFor } from "../common/staff-only-fields";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { dateAndShipmentFilters } from "./list-filters";

/** OrdersService.findAll, moved verbatim (size ratchet): the paged, role-scoped order list. */
export async function findAllOrdersImpl(
  prisma: PrismaService,
  query: ListOrdersDto,
  user: JwtPayload,
) {
  const {
    customerId,
    productId,
    search,
    status,
    urgent,
    page = 1,
    limit = 20,
    fulfillPath,
  } = query;
  const skip = (page - 1) * limit;
  const where: any = {};

  if (user.role === UserRole.CUSTOMER) {
    // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
    // minted just before it stays valid for up to 15 minutes, so a removed customer's own
    // in-flight session must fall into the existing refusal below.
    const customer = await prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
    if (!customer)
      throw new ForbiddenException({
        code: API_ERROR_CODES.CUSTOMER_NOT_LINKED,
        message: "Customer record not found",
      });
    where.customerId = customer.id;
  } else if (customerId) {
    where.customerId = customerId;
  }

  // B144: `search` composes with the role/customerId scope above instead of
  // being swallowed by an `else if` — matches order NUMBER as well as the
  // customer's businessName.
  if (search) {
    where.OR = [
      { orderNumber: { contains: search, mode: "insensitive" } },
      { customer: { businessName: { contains: search, mode: "insensitive" } } },
    ];
  }

  // PR-B: "which orders had this item?" — an AND-ed relation filter, so it
  // narrows whatever customer/status/date filters are already set instead of
  // replacing them. Equality can never match NULL, so ad-hoc unlisted lines
  // (productId = null) are excluded for free.
  if (productId) where.lineItems = { some: { productId } };

  if (status) where.status = status;
  if (urgent !== undefined) where.urgent = urgent;
  // Ad-hoc trips + fulfillment mode: filter by ROUTE/SHIP. Omitted ⇒ no where
  // key at all (every existing order stays visible either way).
  if (fulfillPath) where.fulfillPath = fulfillPath;
  Object.assign(where, dateAndShipmentFilters(query));

  const [data, total] = await Promise.all([
    prisma.forTenant().order.findMany({
      where,
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        // P5-11: pending change-request count for the orders-list badge. Filtered relation count
        // — additive; clients that don't know `_count` ignore it.
        _count: {
          select: {
            changeRequests: { where: { status: ChangeRequestStatus.PENDING } },
          },
        },
      },
      skip,
      take: limit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.forTenant().order.count({ where }),
  ]);

  const rows = ordersFor(user, data); // customer-facing fields only for the customer
  return { data: rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}
