"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { cn, TAP_TARGET } from "@routeflow/ui/web";

/**
 * F28: the image card of a product with NO photos. It used to be a full drop zone that filled the first
 * phone screen and pushed every price below the fold. Now it is one line: a real "Add photos" button
 * (44px touch target) that opens a file picker, and still takes dropped files. Both feed the page's
 * `onFiles` (the crop then upload flow), so that flow is unchanged.
 */
export function ProductImagesEmpty({
  onFiles,
  busy,
}: {
  onFiles: (files: FileList | null) => void;
  busy: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        data-testid="product-images-add-photos"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          TAP_TARGET,
          "w-full gap-2 rounded-lg border border-dashed border-surface-border bg-white px-3 text-sm text-navy/70 transition-colors hover:border-brand-500/50 hover:text-brand-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50",
          dragging && "border-brand-500 ring-2 ring-brand-500",
        )}
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        {busy ? "Uploading…" : "Add photos"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
