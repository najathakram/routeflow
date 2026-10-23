/**
 * H5: the one implementation lives in `@routeflow/types` (`estimate-tax-basis.ts` there); this re-export keeps
 * mobile and web from drifting (same pattern as `lib/read-only-copy.ts`). The SUBPATH import matters: jest stubs the
 * types package ROOT and resolves this subpath to source (jest.config.js).
 */
export { estimateTaxBasisNotice, type EstimateTaxBasis } from "@routeflow/types/estimate-tax-basis";
