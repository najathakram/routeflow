"use client";

import * as React from "react";
import { X, Check } from "lucide-react";
import { Button } from "@routeflow/ui/web";

// ─── Types ────────────────────────────────────────────────────────────────────

type HandleId = "nw" | "ne" | "sw" | "se" | "body";

interface CropBox {
  x: number;    // left in display px
  y: number;    // top in display px
  size: number; // side length in display px (always square / 1:1)
}

interface DragState {
  handleId: HandleId;
  startMouseX: number;
  startMouseY: number;
  startBox: CropBox;
}

export interface CropModalProps {
  file: File;
  fileIndex: number; // 0-based index in the overall batch
  fileTotal: number;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}

const MIN_SIZE_PX = 30;

// ─── Component ────────────────────────────────────────────────────────────────

export function CropModal({ file, fileIndex, fileTotal, onConfirm, onCancel }: CropModalProps) {
  const [src, setSrc] = React.useState<string | null>(null);
  const [dispW, setDispW] = React.useState(0);
  const [dispH, setDispH] = React.useState(0);
  const [natW, setNatW] = React.useState(0);
  const [natH, setNatH] = React.useState(0);
  const [box, setBox] = React.useState<CropBox>({ x: 0, y: 0, size: 0 });
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);

  // Create a blob URL for the selected file
  React.useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setDispW(0); // reset until image loads
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Once the <img> reports its rendered dimensions, initialise the crop box to
  // the largest centred square that fits inside the image.
  const onLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const dw = img.offsetWidth;
    const dh = img.offsetHeight;
    setDispW(dw);
    setDispH(dh);
    setNatW(img.naturalWidth);
    setNatH(img.naturalHeight);
    const size = Math.min(dw, dh);
    setBox({ x: (dw - size) / 2, y: (dh - size) / 2, size });
  };

  // Keep the crop box inside the image bounds and above the minimum size.
  const clamp = React.useCallback((b: CropBox): CropBox => {
    const size = Math.max(MIN_SIZE_PX, Math.min(b.size, dispW, dispH));
    return {
      size,
      x: Math.max(0, Math.min(b.x, dispW - size)),
      y: Math.max(0, Math.min(b.y, dispH - size)),
    };
  }, [dispW, dispH]);

  const startDrag = React.useCallback((e: React.MouseEvent, handleId: HandleId) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag({ handleId, startMouseX: e.clientX, startMouseY: e.clientY, startBox: { ...box } });
  }, [box]);

  // Global mouse-move / mouse-up listeners while dragging
  React.useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - drag.startMouseX;
      const dy = e.clientY - drag.startMouseY;
      const sb = drag.startBox;
      let next: CropBox;

      if (drag.handleId === "body") {
        // Move the whole box
        next = clamp({ x: sb.x + dx, y: sb.y + dy, size: sb.size });
      } else {
        // Resize while keeping a 1:1 ratio.
        // Each corner is anchored at the OPPOSITE corner; we pick the dominant
        // axis delta so the box grows/shrinks smoothly from any direction.
        let delta: number;
        let x = sb.x;
        let y = sb.y;
        switch (drag.handleId) {
          case "se": delta = Math.max(dx, dy);                     break;
          case "sw": delta = Math.max(-dx, dy); x = sb.x - delta; break;
          case "ne": delta = Math.max(dx, -dy); y = sb.y - delta; break;
          case "nw":
          default:   delta = Math.max(-dx, -dy); x = sb.x - delta; y = sb.y - delta; break;
        }
        next = clamp({ x, y, size: sb.size + delta });
      }

      setBox(next);
    };

    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, clamp]);

  // Draw the crop region onto a <canvas> and export as JPEG blob.
  const confirm = React.useCallback(() => {
    const img = imgRef.current;
    if (!img || !natW || !dispW) return;

    const scaleX = natW / dispW;
    const scaleY = natH / dispH;
    const srcX = Math.round(box.x * scaleX);
    const srcY = Math.round(box.y * scaleY);
    const srcW = Math.round(box.size * scaleX);
    const srcH = Math.round(box.size * scaleY);

    // Use the smaller of the two to produce a true square in pixel space,
    // then cap at 2048px to avoid browser canvas memory limits on large photos.
    const MAX_OUT = 2048;
    const outSize = Math.min(srcW, srcH, MAX_OUT);

    const canvas = document.createElement("canvas");
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      // Shouldn't happen in a modern browser, but guard just in case
      console.error("CropModal: could not get 2d context");
      return;
    }
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize);
    canvas.toBlob(
      (blob) => { if (blob) onConfirm(blob); },
      "image/jpeg",
      0.92,
    );
  }, [box, dispW, dispH, natW, natH, onConfirm]);

  const isLast = fileIndex === fileTotal - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        className="flex w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl"
        style={{ maxHeight: "90vh", overflow: "hidden" }}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between border-b border-surface-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Crop Image</h2>
            {fileTotal > 1 && (
              <p className="mt-0.5 text-xs text-navy/50">
                Image {fileIndex + 1} of {fileTotal}
              </p>
            )}
          </div>
          <button onClick={onCancel} className="text-navy/40 hover:text-navy transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ── Crop area ── */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gray-950 p-3">
          {src && (
            <div className="relative inline-block" style={{ lineHeight: 0, userSelect: "none" }}>
              {/* The source image — sized to fit the modal */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={src}
                alt=""
                onLoad={onLoad}
                draggable={false}
                style={{
                  display: "block",
                  maxWidth: "640px",
                  maxHeight: "calc(90vh - 152px)",
                }}
              />

              {dispW > 0 && (
                <>
                  {/* Dark vignette — 4 panels surrounding the crop window */}
                  <DarkPane top={0}           left={0}            width={dispW}                             height={box.y} />
                  <DarkPane top={box.y + box.size} left={0}       width={dispW}                             height={Math.max(0, dispH - box.y - box.size)} />
                  <DarkPane top={box.y}        left={0}            width={box.x}                             height={box.size} />
                  <DarkPane top={box.y}        left={box.x + box.size} width={Math.max(0, dispW - box.x - box.size)} height={box.size} />

                  {/* The active crop box */}
                  <div
                    style={{
                      position: "absolute",
                      top: box.y, left: box.x, width: box.size, height: box.size,
                      border: "2px solid #fff",
                      boxSizing: "border-box",
                      cursor: drag?.handleId === "body" ? "grabbing" : "grab",
                    }}
                    onMouseDown={(e) => startDrag(e, "body")}
                  >
                    {/* Rule-of-thirds guide lines */}
                    <div className="pointer-events-none absolute inset-0">
                      <div className="absolute inset-y-0 border-r border-white/25" style={{ left: "33.33%" }} />
                      <div className="absolute inset-y-0 border-r border-white/25" style={{ left: "66.66%" }} />
                      <div className="absolute inset-x-0 border-b border-white/25" style={{ top: "33.33%" }} />
                      <div className="absolute inset-x-0 border-b border-white/25" style={{ top: "66.66%" }} />
                    </div>

                    {/* Corner resize handles */}
                    {(["nw", "ne", "sw", "se"] as const).map((h) => (
                      <div
                        key={h}
                        onMouseDown={(e) => startDrag(e, h)}
                        style={{
                          position: "absolute",
                          width: 14, height: 14,
                          background: "#fff",
                          border: "2px solid rgba(0,0,0,0.35)",
                          borderRadius: 3,
                          boxSizing: "border-box",
                          cursor: (h === "nw" || h === "se") ? "nwse-resize" : "nesw-resize",
                          ...(h.includes("n") ? { top: -7 } : { bottom: -7 }),
                          ...(h.includes("w") ? { left: -7 } : { right: -7 }),
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-surface-border px-5 py-3.5">
          <p className="text-xs text-navy/50">
            Drag to move · drag corners to resize (1:1 square)
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" leftIcon={<Check className="h-4 w-4" />} onClick={confirm}>
              {isLast ? "Crop & Upload" : "Crop & Next →"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function DarkPane({
  top, left, width, height,
}: {
  top: number; left: number; width: number; height: number;
}) {
  if (width <= 0 || height <= 0) return null;
  return (
    <div
      className="pointer-events-none absolute"
      style={{ top, left, width, height, background: "rgba(0,0,0,0.55)" }}
    />
  );
}
