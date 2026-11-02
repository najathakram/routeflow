import { cn } from "@routeflow/ui/web";
import { LINE_STOCK_WORDS, type LineStockView } from "@/lib/line-stock";

/**
 * SA-1086: the quiet line under an order row: "1 box and 8 pieces left", amber when the order goes past
 * it, red at nothing left. A note, never a control: it has no button and never disables Save.
 */
export function LineStockNote({ stock }: { stock: LineStockView | undefined }) {
  if (!stock) return null;
  if (stock.state === "loading") {
    return (
      <p
        data-testid="line-stock"
        data-state="loading"
        aria-busy
        className="mt-1 text-[11px] text-navy/50"
      >
        {LINE_STOCK_WORDS.loading}
      </p>
    );
  }
  const tone =
    stock.level === "out"
      ? "text-danger"
      : stock.level === "low"
        ? "text-amber-700"
        : "text-navy/60";
  return (
    <div
      data-testid="line-stock"
      data-state="ready"
      data-level={stock.level}
      className={cn("mt-1 text-[11px]", tone)}
    >
      <span className="font-medium">{stock.label}</span>
      {stock.message && (
        <p role="status" data-testid="line-stock-message" className="mt-0.5">
          {stock.message}
        </p>
      )}
    </div>
  );
}
