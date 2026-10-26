import { ADDON_CHANGE_SOURCES, type AddonChangeSource } from "./tenant-addon-writer";

/**
 * Row 556 / SA-970 §2.2 - the classification of EVERY add-on change source, for the unowned-change invariant (I4).
 *
 *   owner            a person (tenant user or platform admin) acts at this call site, so the event's actor is that
 *                    person; a SYSTEM actor on such a source is itself wrong and is flagged.
 *   expected_system  an automatic step that finishes or undoes a change a person already made; not flagged.
 *   alert            a business change (active / price / comp / quantity) with nobody present: fail loud.
 *
 * The maps are `Record<AddonChangeSource, ...>`, so a 16th source in `ADDON_CHANGE_SOURCES` does not compile until it
 * is classified here with a reason (and a source nobody can justify is `alert`).
 */
export type AddonSourceClass = "owner" | "expected_system" | "alert";

export const ADDON_SOURCE_CLASS: Record<AddonChangeSource, AddonSourceClass> = {
  "tenant.enable": "owner",
  "tenant.disable": "owner",
  "admin.enable": "owner",
  "admin.comp": "owner",
  "admin.uncomp": "owner",
  "admin.disable": "owner",
  "subscribe.pick": "owner",
  "subscribe.drop": "owner",
  "profile.apply": "owner",
  "manual_activation.price": "owner",
  "checkout.adopt": "expected_system",
  "plan.stop_billing": "expected_system",
  "plan_change.revert": "expected_system",
  "lock.cancel_clear_item": "expected_system",
  "plan.reprice": "alert",
};

export const ADDON_SOURCE_REASON: Record<AddonChangeSource, string> = {
  "tenant.enable": "the tenant owner turns an add-on on in Settings",
  "tenant.disable": "the tenant owner turns an add-on off in Settings",
  "admin.enable": "a platform admin enables an add-on for the tenant",
  "admin.comp": "a platform admin comps an add-on",
  "admin.uncomp": "a platform admin ends a comp",
  "admin.disable": "a platform admin disables an add-on",
  "subscribe.pick": "the tenant picks add-ons while subscribing",
  "subscribe.drop": "the tenant drops add-ons while subscribing",
  "profile.apply": "a platform admin applies a business profile to the tenant",
  "manual_activation.price":
    "a platform admin runs Manual Activation, which prices the unbilled add-ons",
  "checkout.adopt":
    "completes the tenant's own Stripe checkout; adopts the item and price it paid for",
  "plan.stop_billing":
    "a plan change the tenant or admin made now includes the add-on, so its price falls to $0",
  "plan_change.revert":
    "undoes the pointer changes of a plan change that failed, back to the prior state",
  "lock.cancel_clear_item":
    "the cancellation the tenant asked for clears Stripe items that no longer exist",
  "plan.reprice":
    "a scheduled downgrade raises a price with nobody present; stays loud until a week of findings shows it is routine",
};

/** The class of a source string off the wire; one the map does not know is `alert`. */
export function classOfSource(source: unknown): AddonSourceClass {
  return (ADDON_CHANGE_SOURCES as readonly unknown[]).includes(source)
    ? ADDON_SOURCE_CLASS[source as AddonChangeSource]
    : "alert";
}
