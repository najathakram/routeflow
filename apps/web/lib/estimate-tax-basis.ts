/**
 * H5: the one implementation lives in `@routeflow/types` (`estimate-tax-basis.ts` there); this is a re-export so
 * web and mobile cannot drift (same pattern as `lib/read-only-copy.ts`). The SUBPATH import matters for mobile's
 * jest, which stubs the types package root (jest.config.js).
 */
export { estimateTaxBasisNotice, type EstimateTaxBasis } from "@routeflow/types/estimate-tax-basis";
