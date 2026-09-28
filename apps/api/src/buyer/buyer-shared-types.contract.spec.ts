/**
 * #2703 (SA-562): the buyer response shapes are ONE declaration in @routeflow/types, imported by
 * web + mobile. This file pins each API method's return type to its shared type at COMPILE time
 * (api check-types compiles specs): `Wire<T>` is the JSON a client receives (Date → string), and
 * each pin asserts mutual assignability, so a server field added, dropped or re-typed without
 * the shared type breaks the build.
 */
import type { BuyerFavoriteProduct, BuyerProduct } from "@routeflow/types";
import type { BuyerCatalogService } from "./buyer-catalog.service";

type Wire<T> = T extends Date
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
/** Compiles only when A and B are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pin = <T extends true>(): T => true as T;

describe("buyer shared types (#2703): the API's return types ARE the shared types", () => {
  it("catalog + favorites", () => {
    expect(pin<Same<Row<BuyerCatalogService["getFavorites"]>, BuyerFavoriteProduct>>()).toBe(true);
    expect(pin<Same<Rows<BuyerCatalogService["getCatalog"]>, BuyerProduct>>()).toBe(true);
  });
});
