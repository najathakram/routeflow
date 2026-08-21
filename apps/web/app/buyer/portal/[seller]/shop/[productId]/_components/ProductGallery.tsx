"use client";

import * as React from "react";
import { Package } from "lucide-react";
import { objectPositionForUrl } from "@/lib/image-focal";

// ─── Product Gallery (detail page) ─────────────────────────────────────────────
//
// Main image (4:5, focal-aware, same crop convention as the shop tile) + a
// thumbnail strip when there's more than one image. No images at all falls
// back to the same Package-icon placeholder the tile uses.

export interface ProductGalleryProps {
  images: string[];
  name: string;
}

export function ProductGallery({ images, name }: ProductGalleryProps) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  const activeUrl = images.length > 0 ? images[Math.min(activeIdx, images.length - 1)] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-xl border border-surface-border bg-surface-raised">
        {activeUrl ? (
          <img
            src={activeUrl}
            alt={name}
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(activeUrl) }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="h-16 w-16 text-navy/15" />
          </div>
        )}
      </div>

      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((url, i) => (
            <button
              key={`${url}-${i}`}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={`h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                i === activeIdx
                  ? "border-buyer-500"
                  : "border-surface-border hover:border-buyer-300"
              }`}
              aria-label={`Show image ${i + 1}`}
            >
              <img
                src={url}
                alt=""
                className="h-full w-full object-cover"
                style={{ objectPosition: objectPositionForUrl(url) }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default ProductGallery;
