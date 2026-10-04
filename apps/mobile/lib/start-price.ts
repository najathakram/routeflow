/**
 * B1037 (money): the price a freshly added order-editor line starts at. The customer's OWN price (their tier, or a
 * SPECIAL price: `catalogPrice`, already resolved by the editor), never their remembered last price. A DRIVER
 * starts at LIST: the server bills list for a non-staff driver, and the picker shows list for them (#3114), until the
 * server fix removes that gate. The operator can still edit the price afterwards.
 */
export function freshLineStartPrice(args: {
  catalogPrice: number;
  listPrice: number;
  isDriver: boolean;
}): number {
  return args.isDriver ? args.listPrice : args.catalogPrice;
}
