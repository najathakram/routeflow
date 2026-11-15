/**
 * SA-1160: `OrdersService.findOne`, lifted VERBATIM out of the class (size-ratchet move: orders.service.ts sits at
 * its cap). The body is token-identical to the method it replaces except `this.` -> `self.` (the instance is passed
 * explicitly); the class keeps a thin same-signature delegator (mirrors order-sweep.ts and order-lifecycle.ts), so no
 * call site changes. A pure read: no transaction, no lock, no write.
 */

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { attachPaymentCreditNotes, ORDER_INVOICES_SELECT } from "./order-payment-credit-notes";
import { attachInvoicesNeedReview } from "./order-invoices-review";
import { attachOrderToCollect } from "./order-to-collect";
import { discountModeOf } from "../common/discount-tax-mode";
import { attachRevisionNumber } from "./order-revisions";
import { UserRole } from "@prisma/client";
import { walkInSaleLocked } from "./replace-after-delivery";
import { computeEditWindow } from "./edit-window";
import { ORDER_LINE_ORDER_BY } from "./line-position";
import { attachLinesRearranged } from "./order-line-order";
import { fulfillPathLocked } from "./fulfil-path-lock";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import { orderFor } from "../common/staff-only-fields";
import { withComponentViews } from "./component-view";
import type { OrderReadGateFields } from "@routeflow/types";
import { attachInvoiceStages } from "./order-invoice-stage";
import { HANDOVER_SOLD_BY_SELECT, seesHandOverStamp, stampHandedOverBy } from "./handover-stamp";
import { EDIT_REVISIONS } from "./order-ship-state";
import { tenantSafeParentView } from "../products/product-parent";
import * as rGate from "./order-restriction-gate";
import * as flags from "./offline/review-flags";
import * as carrierGuard from "./order-carrier-guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { OrdersService } from "./orders.service";

export async function findOneImpl(self: OrdersService, id: string, user: JwtPayload) {
  const order = await self.prisma.forTenant().order.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          businessName: true,
          contactName: true,
          phone: true,
          mobile: true,
          email: true,
          isWalkIn: true,
          user: { select: { email: true } }, // account email: the receipt pre-fill fallback
        },
      },
      // Include `unitsPerBox` + `pricePerUnit` so the mobile/web edit UIs can render the boxes/pieces
      // split for boxed products and recompute line subtotals locally without a second roundtrip.
      // `averageCost` + `category` feed the live cost/margin hint + floor in the edit builder
      // (pos-cost-roles-spec §1).
      lineItems: {
        include: {
          components: { orderBy: { position: "asc" } }, // #2717 M3: frozen FIXED-line components
          product: {
            select: {
              id: true,
              name: true,
              unit: true,
              unitsPerBox: true,
              pricePerUnit: true,
              // units_v1 (SA-085f #2): pack tier prices for the picker's ladder, OPERATOR-ONLY
              // — a buyer (this same findOne, buyer.controller.ts) must never see another
              // customer's pricing tier; redactUpsellForCustomer never touched these columns.
              ...(user.role !== UserRole.CUSTOMER
                ? { priceTier2: true, priceTier3: true, priceTier4: true, priceTier5: true }
                : {}),
              averageCost: true,
              category: true,
              // Read-site name composition + SKU line (order-ui-redesign-spec §2/§4): a catalog
              // variant stores only its own flavor in `name`, so the reader needs the parent.
              sku: true,
              unitSku: true,
              variantName: true,
              parentProductId: true,
              // tenantId only for the tenant check below (B1211); it is stripped before the response.
              parent: { select: { name: true, tenantId: true } },
            },
          },
        },
        // Scan/insertion order (R2): all lines in one create share the same
        // createdAt (tx clock), so createdAt alone can't order them — `position`
        // carries the scanned order. Legacy/appended lines have null position and
        // sort LAST (NULLS LAST), with createdAt then id as the final tiebreaks (W-1187: ONE read order).
        orderBy: ORDER_LINE_ORDER_BY,
      },
      ...(flags.seesReviewFlags(user) ? flags.REVIEW_FLAGS_INCLUDE : {}), // SA-1124: staff only
      // row 342: who handed it over (staff only; `registerKey` is a scalar already on the row)
      ...(seesHandOverStamp(user) ? { soldBy: HANDOVER_SOLD_BY_SELECT } : {}),
      transaction: true,
      invoices: { select: ORDER_INVOICES_SELECT }, // + each line's stored taxRate (row 329a)
      // Credit-note INTENTS selected for this order (join table) — the reason/
      // amount/status render at read time via the relation so an edit to the
      // credit note's reason shows up everywhere automatically.
      orderCreditNotes: {
        include: {
          creditNote: {
            select: {
              id: true,
              creditNoteNumber: true,
              reason: true,
              amount: true,
              amountUsed: true,
              status: true,
              expiresAt: true,
            },
          },
        },
      },
      // P5-08: version history + the run state that governs the edit window.
      revisions: EDIT_REVISIONS, // ship-state markers are not edits ("Edited N×")
      // P5-09: post-dispatch change requests, newest first.
      changeRequests: { orderBy: { createdAt: "desc" } },
      // `driverId` feeds the F2-005 driver-ownership gate below.
      routeRun: { select: { status: true, startedAt: true, driverId: true } },
    },
  });
  if (!order) throw new NotFoundException("Order not found");

  // B1211: a product's parent that belongs to another tenant is never shown (name or otherwise).
  // The buyer order reads reach this same method, so they get the check too.
  for (const line of order.lineItems ?? []) {
    const product = line.product as { parent?: { tenantId?: string | null } | null } | null;
    if (product && "parent" in product) {
      product.parent = tenantSafeParentView(
        product.parent,
        order.tenantId ?? self.prisma.getTenantId(),
      );
    }
  }

  await rGate.stampOverrideNames(self.prisma.forTenant(), order.lineItems, user); // row 510: staff only
  if (user.role === UserRole.CUSTOMER) {
    // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
    // minted just before it stays valid for up to 15 minutes, so a removed customer's own
    // in-flight session must fall into the existing refusal below.
    const customer = await self.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
    if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    // A customer must never see an upsell's base price / that they were upsold.
    redactUpsellForCustomer(order);
  }

  // F2-005: a DRIVER may only read an order that is on a run they are the
  // driver of — otherwise they could enumerate any order's full detail.
  // Orders not yet on a run (routeRun null) are never driver-readable.
  if (user.role === UserRole.DRIVER) {
    const driver = await self.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } });
    if (!driver || order.routeRun?.driverId !== driver.id) throw new ForbiddenException();
  }

  // P5-08 edit window (G7): free editing is open until the order's run dispatches.
  // `editableUntil` (the soft cutoff countdown) stays null until the per-weekday
  // routes-cutoff config lands — the HARD close is dispatch, which is authoritative.
  (order as any).editWindow = computeEditWindow(order, user.role);
  // B1083: the web disables Cancel from this (one server predicate, never re-derived client-side).
  Object.assign(order, {
    cancelBlockedReason: await carrierGuard.carrierBlocked(self, order),
    fulfillPathLocked: fulfillPathLocked(order), // row 673: the PATCH's own predicate
    editItemsLocked: await walkInSaleLocked(self.prisma.forTenant(), order), // W-861: the edit's own predicate
  } satisfies OrderReadGateFields);
  Object.assign(order, { discountTaxBase: discountModeOf(order) }); // SA-1141 R7: the footers read the mode, never the clock
  await attachInvoiceStages(self.featureConfig, order); // fold 4: each invoice's pdfVariant
  attachRevisionNumber(order); // row 372
  order.lineItems = withComponentViews(order.lineItems) as typeof order.lineItems; // #2717 M3

  await attachPaymentCreditNotes(self.prisma.forTenant(), order); // #2404
  await attachInvoicesNeedReview(self.prisma.forTenant(), order, user); // B1116 (staff only)
  await attachOrderToCollect(self.prisma.forTenant(), order, user); // SA-1026 (staff only)
  await attachLinesRearranged(self.prisma.forTenant(), order, user); // W-1187 (staff only)

  stampHandedOverBy(order, user); // row 342: staff only; the display name is built once, here
  return orderFor(user, order); // customer-facing fields only for the customer
}
