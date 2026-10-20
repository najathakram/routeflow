// SA-788 (c): the result of POST /platform-admin/tenants/:id/activate-subscription. Before this the web treated it as
// `unknown`. The add-on lists let the admin check, at the moment of the action, that no add-on was switched off.

/** One of the tenant's add-ons as the activation sees it (a row, not the catalog). */
export interface ActivationAddonState {
  addonKey: string;
  sku: string | null;
  name: string;
  active: boolean;
  /** The frozen monthly price on the row; null/0 = unbilled or included. */
  priceSnapshot: number | null;
  isComp: boolean;
}

/** One field of one add-on that this activation changed. */
export interface ActivationAddonChange {
  addonKey: string;
  field: "active" | "priceSnapshot" | "isComp";
  before: boolean | number | null;
  after: boolean | number | null;
}

export interface ManualActivationAddons {
  before: ActivationAddonState[];
  after: ActivationAddonState[];
  changed: ActivationAddonChange[];
}

export interface ManualActivationResult {
  id: string;
  slug: string;
  status: string;
  plan: string;
  /** ISO dates over the wire. */
  periodStart: string;
  periodEnd: string;
  paymentMethod: string;
  paymentRef: string | null;
  /** True when the same payment was already recorded: nothing was written by this call. */
  repeated?: boolean;
  addons: ManualActivationAddons;
}
