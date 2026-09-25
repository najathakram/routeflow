"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2 } from "lucide-react";
import { useToast } from "@routeflow/ui/web";
import { useProducts } from "@/lib/api/products";
import { archivedMessage, resolveProductByCode } from "@/lib/barcode-resolve";
import { displayProductName } from "@/lib/product-display";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";

/**
 * #2119 (plan §A9): the one shared way into product insights — camera scan
 * through the existing barcode resolve ladder, or a typeahead search. Both
 * paths land on `/insights/products/[id]`.
 *
 * Typeahead is `GET /products?search=` at `limit: 20` — never `limit=0`
 * (that sentinel means "fetch every row" elsewhere in this app; a finder
 * has no business asking for the whole catalog on a keystroke).
 */

const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 300;

export function ProductFinder() {
  const router = useRouter();
  const { toast } = useToast();
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [scanMessage, setScanMessage] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const trimmed = debouncedQuery.trim();
  const { data, isLoading } = useProducts(
    { search: trimmed, limit: SEARCH_LIMIT },
    { enabled: trimmed.length > 0 },
  );
  const results = data?.data ?? [];

  const goToProduct = React.useCallback(
    (productId: string) => {
      router.push(`/insights/products/${productId}`);
    },
    [router],
  );

  const handleScan = React.useCallback(
    async (code: string) => {
      setScanMessage(null);
      setScanning(true);
      try {
        const result = await resolveProductByCode(code);
        if (result.archived) {
          // F30 / R5: an archived product still has sales history worth
          // reading — insights is a read surface, so this is informational,
          // never a hard stop the way "select for a new order line" is.
          toast({ title: archivedMessage(result.product), variant: "warning" });
          goToProduct(result.product.id);
        } else if (!result.notFound) {
          goToProduct(result.product.id);
        } else {
          setScanMessage(`No product for "${code}"`);
        }
      } catch {
        toast({
          title: "Couldn't look up that code",
          description: "Check your connection and try again.",
          variant: "error",
        });
      } finally {
        setScanning(false);
      }
    },
    [goToProduct, toast],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setScanMessage(null);
            }}
            placeholder="Search by name, SKU or scan a barcode…"
            aria-label="Search products"
            className="h-10 w-full rounded border border-surface-border bg-white pl-9 pr-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <BarcodeScannerButton onScan={handleScan} title="Scan a product to find its insights" />
      </div>

      {scanning && (
        <p className="flex items-center gap-1.5 text-sm text-navy/70">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up…
        </p>
      )}
      {scanMessage && <p className="text-sm text-danger">{scanMessage}</p>}

      {trimmed.length > 0 && (
        <div
          className="rounded-md border border-surface-border bg-white"
          data-testid="finder-results"
        >
          {isLoading ? (
            <p className="p-4 text-sm text-navy/70">Searching…</p>
          ) : results.length === 0 ? (
            <p className="p-4 text-sm text-navy/70">No products match &quot;{trimmed}&quot;.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {results.map((p: any) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => goToProduct(p.id)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-navy hover:bg-surface-raised"
                  >
                    <span>{displayProductName(p)}</span>
                    {p.sku && <span className="font-mono text-xs text-navy/50">{p.sku}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
