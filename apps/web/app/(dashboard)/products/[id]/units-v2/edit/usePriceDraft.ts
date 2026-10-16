// PLACEHOLDER until K3 merges: K3 owns this file (units-v2/edit/usePriceDraft.ts) and its version REPLACES this one.
// It declares only the SPRINT-CONTRACT §3 surface K4 relies on, so the plan panels compile and can be tested with
// jest.mock. Assumed read fields (K3 to provide): plan.ticked / plan.keeps / plan.customerKeeps, and the optional
// `on` argument of keepCustomer (false = undo the customer Keep).
import type { LadderView, Pin, PricePlan } from "@routeflow/pricing";
import type {
  CustomerPriceMove,
  PriceCellKeep,
  PriceTierNumber,
  ProductPriceGridDto,
} from "@routeflow/types";

/** The open plan under an edited cell, with what the owner ticked on it. */
export interface DraftPlan {
  plan: PricePlan;
  cell: { ref: string; tier: PriceTierNumber };
  /** By offer index. */
  ticked: readonly boolean[];
  keeps: readonly PriceCellKeep[];
  customerKeeps: readonly CustomerPriceMove[];
}

export interface PriceDraft {
  grid: ProductPriceGridDto | undefined;
  view: LadderView;
  dirty: boolean;
  plan: DraftPlan | null;
  setOfferTicked: (index: number, on: boolean) => void;
  keep: (pin: Pin) => void;
  unkeep: (pin: Pin) => void;
  keepCustomer: (move: CustomerPriceMove, on?: boolean) => void;
  /** Change prices Apply: fold the plan into the draft. Save is the only commit. */
  applyPlan: (plan: PricePlan) => void;
}

export function usePriceDraft(): PriceDraft {
  throw new Error("usePriceDraft is a placeholder until K3 merges");
}
