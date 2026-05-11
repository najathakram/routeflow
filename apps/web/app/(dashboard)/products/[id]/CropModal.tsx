"use client";

import * as React from "react";
import { X, Check, ArrowLeft } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import type { FocalPoint } from "@/lib/image-focal";
import { CENTER_FOCAL } from "@/lib/image-focal";

// ─── Types ────────────────────────────────────────────────────────────────────

type HandleId = "nw" | "ne" | "sw" | "se" | "body";

interface CropBox {
  x: number;      // left in display px
  y: number;      // top in display px
  width: number;  // in display px
  height: number; // in display px (always = width * 5/4 — portrait 4:5)
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
  /** Receives the cropped JPEG blob AND the chosen focal point (0..100). */
  onConfirm: (blob: Blob, focal: FocalPoint) => void;
  onCancel: () => void;
}

const MIN_WIDTH_PX = 30;
/** Crop ratio width:height. 4:5 → portrait, taller than wide. */
const ASPECT_W_OVER_H = 4 / 5;

type Phase = "crop" | "focal";

// ─── Component ────────────────────────────────────────────────────────────────

export function CropModal({ file, fileIndex, fileTotal, onConfirm, onCancel }: CropModalProps) {
  const [phase, setPhase] = React.useState<Phase>("crop");

  // Source image state
  const [src, setSrc] = React.useState<string | null>(null);
  const [dispW, setDispW] = React.useState(0);
  const [dispH, setDispH] = React.useState(0);
  const [natW, setNatW] = React.useState(0);
  const [natH, setNatH] = React.useState(0);
  const [box, setBox] = React.useState<CropBox>({ x: 0, y: 0, width: 0, height: 0 });
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);

  // Focal phase state
  const [croppedUrl, setCroppedUrl] = React.useState<string | null>(null);
  const [croppedBlob, setCroppedBlob] = React.useState<Blob | null>(null);
  const [focal, setFocal] = React.useState<FocalPoint>(CENTER_FOCAL);
  const [focalDragging, setFocalDragging] = React.useState(false);
  const focalImgRef = React.useRef<HTMLImageElement>(null);

  // Reset everything when a new file comes in
  React.useEffect(() => {
    setPhase("crop");
    setCroppedBlob(null);
    setFocal(CENTER_FOCAL);
  }, [file]);

  // Create a blob URL for the source file
  React.useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setDispW(0); // reset until image loads
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Manage the cropped-preview blob URL lifetime
  React.useEffect(() => {
    if (!croppedBlob) return;
    const url = URL.createObjectURL(croppedBlob);
    setCroppedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [croppedBlob]);

  // Once the <img> reports its rendered dimensions, initialise the crop box
  // to the largest centred 4:5 rectangle that fits inside the image.
  const onLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const dw = img.offsetWidth;
    const dh = img.offsetHeight;
    setDispW(dw);
    setDispH(dh);
    setNatW(img.naturalWidth);
    setNatH(img.naturalHeight);

    // Fit the largest 4:5 rectangle inside (dw, dh)
    const fitByWidth = { w: dw, h: dw / ASPECT_W_OVER_H };
    const fitByHeight = { w: dh * ASPECT_W_OVER_H, h: dh };
    const fit = fitByWidth.h <= dh ? fitByWidth : fitByHeight;
    setBox({
      width: fit.w,
      height: fit.h,
      x: (dw - fit.w) / 2,
      y: (dh - fit.h) / 2,
    });
  };

  // Keep the box inside image bounds and above min size, maintaining 4:5.
  const clamp = React.useCallback((b: CropBox): CropBox => {
    let width = Math.max(MIN_WIDTH_PX, Math.min(b.width, dispW, dispH * ASPECT_W_OVER_H));
    let height = width / ASPECT_W_OVER_H;
    if (height > dispH) {
      height = dispH;
      width = height * ASPECT_W_OVER_H;
    }
    return {
      width,
      height,
      x: Math.max(0, Math.min(b.x, dispW - width)),
      y: Math.max(0, Math.min(b.y, dispH - height)),
    };
  }, [dispW, dispH]);

  const startDrag = React.useCallback((e: React.MouseEvent, handleId: HandleId) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag({ handleId, startMouseX: e.clientX, startMouseY: e.clientY, startBox: { ...box } });
  }, [box]);

  // Global mouse-move / mouse-up listeners while dragging the crop box
  React.useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - drag.startMouseX;
      const dy = e.clientY - drag.startMouseY;
      const sb = drag.startBox;
      let next: CropBox;

      if (drag.handleId === "body") {
        next = clamp({ x: sb.x + dx, y: sb.y + dy, width: sb.width, height: sb.height });
      } else {
        // Corner resize: pick the dominant axis delta, then derive the
        // other axis from the 4:5 aspect ratio so the crop never warps.
        let dWidth: number;
        switch (drag.handleId) {
          case "se": dWidth = Math.max(dx, dy * ASPECT_W_OVER_H); break;
          case "sw": dWidth = Math.max(-dx, dy * ASPECT_W_OVER_H); break;
          case "ne": dWidth = Math.max(dx, -dy * ASPECT_W_OVER_H); break;
          case "nw":
          default:   dWidth = Math.max(-dx, -dy * ASPECT_W_OVER_H); break;
        }
        const newWidth = sb.width + dWidth;
        const newHeight = newWidth / ASPECT_W_OVER_H;
        const dHeight = newHeight - sb.height;
        let x = sb.x;
        let y = sb.y;
        if (drag.handleId === "sw" || drag.handleId === "nw") x = sb.x - dWidth;
        if (drag.handleId === "ne" || drag.handleId === "nw") y = sb.y - dHeight;
        next = clamp({ x, y, width: newWidth, height: newHeight });
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

  // Draw the crop region onto a <canvas> and stash as a JPEG blob, then
  // advance to the focal-point step.
  const cropAndAdvance = React.useCallback(() => {
    const img = imgRef.current;
    if (!img || !natW || !dispW) return;

    const scaleX = natW / dispW;
    const scaleY = natH / dispH;
    const srcX = Math.round(box.x * scaleX);
    const srcY = Math.round(box.y * scaleY);
    const srcW = Math.round(box.width * scaleX);
    const srcH = Math.round(box.height * scaleY);

    // Cap at 2048 on the long edge to keep canvas memory bounded for huge photos.
    const MAX_OUT_LONG = 2048;
    const longEdge = Math.max(srcW, srcH);
    const scaleOut = longEdge > MAX_OUT_LONG ? MAX_OUT_LONG / longEdge : 1;
    const outW = Math.round(srcW * scaleOut);
    const outH = Math.round(srcH * scaleOut);

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.error("CropModal: could not get 2d context");
      return;
    }
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setCroppedBlob(blob);
        setFocal(CENTER_FOCAL);
        setPhase("focal");
      },
      "image/jpeg",
      0.92,
    );
  }, [box, dispW, dispH, natW, natH]);

  // ── Focal point handlers ─────────────────────────────────────────────────
  const setFocalFromEvent = React.useCallback((clientX: number, clientY: number) => {
    const img = focalImgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    setFocal({
      x: Math.max(0, Math.min(100, Math.round(x))),
      y: Math.max(0, Math.min(100, Math.round(y))),
    });
  }, []);

  React.useEffect(() => {
    if (!focalDragging) return;
    const onMove = (e: MouseEvent) => setFocalFromEvent(e.clientX, e.clientY);
    const onUp = () => setFocalDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [focalDragging, setFocalFromEvent]);

  const confirmFocal = () => {
    if (!croppedBlob) return;
    onConfirm(croppedBlob, focal);
  };

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
            <h2 className="text-base font-semibold text-navy">
              {phase === "crop" ? "Crop Image (4:5 portrait)" : "Set Focal Point"}
            </h2>
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

        {/* ── Body ── */}
        {phase === "crop" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gray-950 p-3">
            {src && (
              <div className="relative inline-block" style={{ lineHeight: 0, userSelect: "none" }}>
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
                    maxHeight: "calc(90vh - 180px)",
                  }}
                />

                {dispW > 0 && (
                  <>
                    {/* Dark vignette — 4 panels surrounding the crop window */}
                    <DarkPane top={0}                  left={0}                       width={dispW}                                                  height={box.y} />
                    <DarkPane top={box.y + box.height} left={0}                       width={dispW}                                                  height={Math.max(0, dispH - box.y - box.height)} />
                    <DarkPane top={box.y}              left={0}                       width={box.x}                                                  height={box.height} />
                    <DarkPane top={box.y}              left={box.x + box.width}       width={Math.max(0, dispW - box.x - box.width)}                 height={box.height} />

                    {/* The active crop box */}
                    <div
                      style={{
                        position: "absolute",
                        top: box.y, left: box.x, width: box.width, height: box.height,
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
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-gray-950 p-3">
            {croppedUrl && (
              <>
                <p className="text-xs text-white/70">
                  Click or drag to set the focal point — this is the area we&apos;ll keep visible
                  when the image is shown at other aspect ratios.
                </p>
                <div
                  className="relative inline-block cursor-crosshair"
                  style={{ lineHeight: 0, userSelect: "none" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setFocalFromEvent(e.clientX, e.clientY);
                    setFocalDragging(true);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={focalImgRef}
                    src={croppedUrl}
                    alt=""
                    draggable={false}
                    style={{
                      display: "block",
                      maxWidth: "min(360px, 70vw)",
                      maxHeight: "calc(90vh - 220px)",
                    }}
                  />
                  {/* Focal point marker */}
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      left: `${focal.x}%`,
                      top: `${focal.y}%`,
                      transform: "translate(-50%, -50%)",
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      border: "3px solid white",
                      background: "rgba(0, 0, 0, 0.35)",
                      boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.5)",
                    }}
                  />
                </div>
                <p className="text-[11px] text-white/50">
                  Focal: {focal.x}% × {focal.y}%
                </p>
              </>
            )}
          </div>
        )}

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-surface-border px-5 py-3.5">
          <p className="text-xs text-navy/50">
            {phase === "crop"
              ? "Drag to move · drag corners to resize (4:5 portrait)"
              : "The focal point keeps that part of the image visible everywhere"}
          </p>
          <div className="flex gap-2">
            {phase === "focal" ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<ArrowLeft className="h-4 w-4" />}
                  onClick={() => setPhase("crop")}
                >
                  Back to crop
                </Button>
                <Button size="sm" leftIcon={<Check className="h-4 w-4" />} onClick={confirmFocal}>
                  {isLast ? "Save & Upload" : "Save & Next →"}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={onCancel}>
                  Cancel
                </Button>
                <Button size="sm" leftIcon={<Check className="h-4 w-4" />} onClick={cropAndAdvance}>
                  Next: focal point →
                </Button>
              </>
            )}
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
