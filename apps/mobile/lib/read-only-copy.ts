/**
 * SA-776 (row 382): the one implementation lives in `@routeflow/types` (`read-only-copy.ts` there); this is a
 * re-export so mobile and web cannot drift (same pattern as `lib/internal-email.ts`). Mobile has no workspace
 * read-only surface yet: when it ships it calls `readOnlyCopy({...})` with the subscription view's fields. The
 * SUBPATH import matters: jest stubs the types package ROOT and resolves this subpath to source (jest.config.js).
 */
export {
  READ_ONLY_SENTENCE,
  readOnlyContactLine,
  readOnlyCopy,
  readOnlyCopyText,
  readOnlyReasonLine,
} from "@routeflow/types/read-only-copy";
export type { ReadOnlyCopy, ReadOnlyCopyInput } from "@routeflow/types/read-only-copy";
