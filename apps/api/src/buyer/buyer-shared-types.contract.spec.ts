/**
 * #2703 (SA-562): the buyer response shapes are ONE declaration in @routeflow/types, imported by
 * web + mobile. This file pins each API method's return type to its shared type at COMPILE time
 * (api check-types compiles specs): `Wire<T>` is the JSON a client receives (Date → string), and
 * each pin asserts mutual assignability, so a server field added, dropped or re-typed without
 * the shared type breaks the build.
 */
import type { Prisma } from "@prisma/client";
import type {
  BuyerFavoriteProduct,
  BuyerInvoiceItem,
  BuyerInvoiceListItem,
  BuyerInvoicePayment,
  BuyerOrder,
  BuyerOrderListItem,
  BuyerProduct,
  ChangeRequest,
  DecimalWire,
} from "@routeflow/types";
import type { InvoicesService } from "../invoices/invoices.service";
import type { OrdersService } from "../orders/orders.service";
import type { computeEditWindow } from "../orders/edit-window";
import type { BuyerCatalogService } from "./buyer-catalog.service";

/** SA-562a: a Decimal column maps to DecimalWire (a string on the wire today — #2705). */
type Wire<T> = T extends Prisma.Decimal
  ? DecimalWire
  : T extends Date
    ? string
    : T extends Array<infer U>
      ? Wire<U>[]
      : T extends object
        ? { [K in keyof T]: Wire<T[K]> }
        : T;
type Row<M extends (...args: never[]) => Promise<unknown>> =
  Awaited<ReturnType<M>> extends Array<infer U> ? Wire<U> : never;
type Rows<M extends (...args: never[]) => Promise<{ data: unknown[] }>> = Wire<
  Awaited<ReturnType<M>>["data"][number]
>;
/** One-way (SA-562a): the server's payload satisfies the shared type. The API returns every
 *  Order column plus relations; the shared type names what clients read, so extra server
 *  fields are fine — a dropped or re-typed one is not. */
type Satisfies<Server, Shared> = [Server] extends [Shared] ? true : false;
/** ChangeRequest.payload (Json) and .resolution (free String?) are app-level narrowings of
 *  untyped columns — compare those two at the server's own types, everything else strictly. */
type NarrowedCR<T> = T extends { changeRequests: Array<infer C> }
  ? Omit<T, "changeRequests"> & {
      changeRequests: Array<
        Omit<C, "payload" | "resolution"> & Pick<ChangeRequest, "payload" | "resolution">
      >;
    }
  : T;
type FindAllRow = Wire<Awaited<ReturnType<OrdersService["findAll"]>>["data"][number]>;
type FindOneRow = NarrowedCR<
  Wire<Awaited<ReturnType<OrdersService["findOne"]>>> & {
    editWindow: ReturnType<typeof computeEditWindow>;
  }
>;
type InvoiceRow = Wire<Awaited<ReturnType<InvoicesService["findOne"]>>>;
type InvoiceListRow = Wire<Awaited<ReturnType<InvoicesService["findAll"]>>["data"][number]>;
/** Compiles only when A and B are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pin = <T extends true>(): T => true as T;

describe("buyer shared types (#2703): the API's return types ARE the shared types", () => {
  it("catalog + favorites", () => {
    expect(pin<Same<Row<BuyerCatalogService["getFavorites"]>, BuyerFavoriteProduct>>()).toBe(true);
    expect(pin<Same<Rows<BuyerCatalogService["getCatalog"]>, BuyerProduct>>()).toBe(true);
  });

  it("orders: findAll → BuyerOrderListItem, findOne (+ editWindow) → BuyerOrder (one-way)", () => {
    expect(pin<Satisfies<FindAllRow, BuyerOrderListItem>>()).toBe(true);
    expect(pin<Satisfies<FindOneRow, BuyerOrder>>()).toBe(true);
  });

  it("invoices list (B1122): findAll rows → BuyerInvoiceListItem (one-way)", () => {
    // The portal reads `total` and `balanceDue`; a server rename without the shared type breaks the build.
    expect(pin<Satisfies<InvoiceListRow, BuyerInvoiceListItem>>()).toBe(true);
  });

  it("invoice detail: findOne's items / payments → BuyerInvoiceItem / BuyerInvoicePayment (one-way)", () => {
    expect(pin<Satisfies<InvoiceRow["items"][number], BuyerInvoiceItem>>()).toBe(true);
    expect(pin<Satisfies<InvoiceRow["payments"][number], BuyerInvoicePayment>>()).toBe(true);
  });
});
