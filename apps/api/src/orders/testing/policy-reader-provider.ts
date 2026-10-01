import { PolicyOversellReader } from "../policy-oversell-reader";

/**
 * L-247: the shared test provider for `PolicyOversellReader`, which OrdersService,
 * OrderTemplatesService and BuyerController now inject. The policy reads "off" (today's behaviour),
 * so every pre-WS9 assertion holds. Add it to a hand-written `providers: [...]` array that builds
 * one of those classes; a spec that needs a specific policy supplies its own provider instead.
 */
export const oversellReaderOffProvider = {
  provide: PolicyOversellReader,
  useValue: { read: async () => "off" },
};
