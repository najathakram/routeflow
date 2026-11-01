"use client";

import * as React from "react";
import type { AxiosInstance } from "axios";
import { Printer } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { fetchAccountStatementPdfUrl } from "@/lib/api/account-statement";
import { STATEMENT_COPY } from "@/lib/account-statement-display";
import { fetchPdfBlob } from "@/lib/fetch-pdf-blob";
import { isInShell } from "@/lib/in-shell";
import { printPdfBlob } from "@/lib/print-pdf-blob";

/**
 * SA-1078 PR-3 PD6/PD7: where a statement prints. A finger-first device or the app shell can't print from a hidden frame
 * (and a script-opened tab after an await is blocked), so it gets two taps: "Print or share" fetches the PDF, then a real
 * "Open PDF" link opens the signed URL in the system browser, which has Share and Print. A desktop prints straight away.
 */
const isTouchDevice = (): boolean => {
  if (isInShell()) return true;
  try {
    return (
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
    );
  } catch {
    return false;
  }
};

/**
 * The print control, over where the signed URL comes from (`getUrl`) and the client that fetches the bytes (`client`): the
 * staff button below and the buyer portal's twin differ only in those two.
 */
export function StatementPrintControl({
  getUrl,
  client,
}: {
  getUrl: () => Promise<string>;
  client: AxiosInstance;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [openUrl, setOpenUrl] = React.useState<string | null>(null);
  // Read once per mount; the figure's device does not change while the sheet is open.
  const [touch] = React.useState(isTouchDevice);

  async function run() {
    setBusy(true);
    try {
      const url = await getUrl();
      if (touch) {
        setOpenUrl(url);
      } else {
        printPdfBlob(await fetchPdfBlob(url, client));
      }
    } catch {
      // The sheet stays open, with its figures, so the person can try again.
      toast({
        title: STATEMENT_COPY.printFailedTitle,
        description: STATEMENT_COPY.printFailedBody,
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid="statement-print"
        leftIcon={<Printer className="h-4 w-4" aria-hidden />}
        disabled={busy}
        onClick={() => void run()}
      >
        {touch ? STATEMENT_COPY.printOrShare : STATEMENT_COPY.print}
      </Button>
      {openUrl ? (
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="statement-open-pdf"
          className="inline-flex min-h-[44px] items-center rounded px-2 text-sm font-medium text-brand-700 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          {STATEMENT_COPY.openPdf}
        </a>
      ) : null}
    </div>
  );
}

export function StatementPrintButton({ customerId }: { customerId: string }) {
  const getUrl = React.useCallback(() => fetchAccountStatementPdfUrl(customerId), [customerId]);
  return <StatementPrintControl getUrl={getUrl} client={apiClient} />;
}
