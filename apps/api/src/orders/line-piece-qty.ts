/**
 * RF-4 / B679: the piece count a per-unit category tax multiplies. SA-1086: the ONE conversion now lives
 * in `@routeflow/pricing` (`stock-pieces.ts`) so the order screens' live stock note reads the same code as
 * the save; this file only keeps the import path the order paths already use. Never a second copy here.
 */
export { linePieceQty } from "@routeflow/pricing";
