"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import type { ContinuousScanCamera } from "./useContinuousScanCamera";

/**
 * The camera strip's picture: the live `<video>`, the aim box drawn over it, and the reason when the camera could not start.
 * ONE component for every continuous-scan surface (the order builder's `ScanOrderScreen` and the counter's
 * `CounterCameraStrip`, SA-1059), so the drawn box and `AIM_BOX_FRACTION` (lib/scan-aim.ts) stay one. `children` sit on top of
 * the picture (the builder's Hold button, the counter's buttons) and are not rendered while the camera has an error.
 */
export function ScanViewfinder({
  camera,
  className,
  children,
}: {
  camera: Pick<ContinuousScanCamera, "videoRef" | "error" | "refocus">;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    // Camera strip: wide and short (a barcode is held that way); object-cover crops the frame
    // for display only - zxing still reads all of it.
    <div className={cn("relative h-36 shrink-0 bg-black sm:h-44", className)}>
      {camera.error ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/80">
          {camera.error}
        </div>
      ) : (
        <>
          <video
            ref={camera.videoRef}
            className="h-full w-full cursor-pointer object-cover"
            autoPlay
            muted
            playsInline
            onClick={camera.refocus}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-3/5 w-5/6 rounded border-2 border-brand-400 opacity-80" />
          </div>
          {children}
        </>
      )}
    </div>
  );
}
