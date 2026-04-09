"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Package,
  Pencil,
  Check,
  X,
  Upload,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Star,
  Scissors,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Badge, Button, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useProduct, useProducts, useUpdateProduct, useDeleteProduct, useUploadProductImages, useDeleteProductImage } from "@/lib/api/products";
import { useAuth } from "@/lib/auth-context";
import { CropModal } from "./CropModal";
import { ImageLightbox } from "./ImageLightbox";

const COMMON_UNITS = [
  "unit", "each", "case", "box", "bag", "pack", "dozen", "pallet",
  "kg", "g", "lb", "oz", "L", "ml", "tray", "bottle", "can", "roll", "sheet",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic 30-day demand data seeded by product ID. */
function generateDemandData(productId: string): { day: string; units: number }[] {
  const seed = Array.from(productId).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const base = new Date(2026, 1, 8); // Feb 8
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const units = Math.max(
      1,
      Math.round(8 + ((seed * 3 + i * 7) % 14) + Math.round(Math.sin((i + seed) * 0.7) * 4)),
    );
    return { day: `${d.getMonth() + 1}/${d.getDate()}`, units };
  });
}

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

function getStockStatus(currentStock: number, isActive: boolean): StockStatus {
  if (!isActive) return "OUT_OF_STOCK";
  if (currentStock <= 0) return "OUT_OF_STOCK";
  if (currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-navy/50">{label}</p>
      <div className="mt-0.5 text-sm font-medium text-navy">{value}</div>
    </div>
  );
}

// ─── Inline number field ──────────────────────────────────────────────────────

function EditableNumber({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={0}
      step={0.01}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data: product, isLoading } = useProduct(params.id);
  const { data: allProductsResult } = useProducts({ limit: 0 });
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const uploadImages = useUploadProductImages(params.id);
  const deleteImage = useDeleteProductImage(params.id);

  const [isEditing, setIsEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState<Record<string, unknown>>({});
  const [isMounted, setIsMounted] = React.useState(false);
  const [activeImageIdx, setActiveImageIdx] = React.useState(0);
  const [isDragging, setIsDragging] = React.useState(false);
  const [selectedImages, setSelectedImages] = React.useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";

  // ── Lightbox state ────────────────────────────────────────────────────────
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [lightboxIdx, setLightboxIdx] = React.useState(0);

  // ── Crop-existing state ───────────────────────────────────────────────────
  // When set, the next crop completion replaces this key instead of adding a new image
  const [cropExistingKey, setCropExistingKey] = React.useState<string | null>(null);

  // ── Crop-before-upload state ──────────────────────────────────────────────
  // When the user picks files we queue them here; CropModal works through them
  // one-by-one. Once the queue is empty the cropped blobs are uploaded.
  const [cropState, setCropState] = React.useState<{
    queue: File[];
    accumulated: Blob[];
  } | null>(null);

  // Derived: all known categories and units from the catalog
  const allProducts: any[] = allProductsResult?.data ?? [];
  const catalogCategories = Array.from(new Set(allProducts.map((p: any) => p.category).filter(Boolean))) as string[];
  const catalogUnits = Array.from(new Set([...COMMON_UNITS, ...allProducts.map((p: any) => p.unit).filter(Boolean)])).sort() as string[];

  // Reset active image index if images change
  React.useEffect(() => {
    setActiveImageIdx(0);
  }, [product?.id]);

  React.useEffect(() => { setIsMounted(true); }, []);
  React.useEffect(() => {
    setTitle(product?.name ?? "Product");
  }, [setTitle, product?.name]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-navy/40">Loading...</div>
    );
  }

  if (!product) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Product not found.</p>
        <Button variant="secondary" href="/products">Back to Products</Button>
      </div>
    );
  }

  const priceNumber = parseFloat(String(product.pricePerUnit));
  const currentStock = Number(product.currentStock ?? 0);
  const stockStatus = getStockStatus(currentStock, product.isActive);
  const demandData = generateDemandData(product.id);

  const startEdit = () => {
    setEditDraft({
      name: product.name,
      sku: product.sku ?? "",
      unit: product.unit,
      pricePerUnit: String(priceNumber),
      priceTier2: String(parseFloat(String(product.priceTier2 ?? priceNumber))),
      priceTier3: String(parseFloat(String(product.priceTier3 ?? priceNumber))),
      priceTier4: String(parseFloat(String(product.priceTier4 ?? priceNumber))),
      priceTier5: String(parseFloat(String(product.priceTier5 ?? priceNumber))),
      category: product.category ?? "",
      description: product.description ?? "",
    });
    setIsEditing(true);
  };

  const saveEdit = () => {
    updateProduct.mutate({ id: params.id, ...editDraft });
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setEditDraft({});
    setIsEditing(false);
  };

  // ── Crop helpers ──────────────────────────────────────────────────────────

  /** Called by the drop zone / file input — opens the crop modal queue. */
  const queueForCrop = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Reset the input value so the same file(s) can be re-selected if cancelled.
    if (fileInputRef.current) fileInputRef.current.value = "";
    setCropState({ queue: Array.from(files), accumulated: [] });
  };

  /** Called by CropModal each time the user confirms one crop. */
  const handleCropConfirm = async (blob: Blob) => {
    if (!cropState) return;
    const accumulated = [...cropState.accumulated, blob];
    const queue = cropState.queue.slice(1);

    if (queue.length === 0) {
      setCropState(null);
      try {
        if (cropExistingKey) {
          // Replacing an existing image: upload cropped version first, then remove original
          const file = new File(
            [accumulated[0]],
            `product-image-${Date.now()}.jpg`,
            { type: "image/jpeg" },
          );
          await uploadImages.mutateAsync([file]);
          await deleteImage.mutateAsync(cropExistingKey);
          setCropExistingKey(null);
          toast({ title: "Image cropped and replaced", variant: "success" });
        } else {
          // Normal upload flow
          const files = accumulated.map((b, i) =>
            new File([b], `product-image-${Date.now()}-${i}.jpg`, { type: "image/jpeg" }),
          );
          await uploadImages.mutateAsync(files);
          toast({
            title: `${files.length} image${files.length !== 1 ? "s" : ""} uploaded`,
            variant: "success",
          });
        }
      } catch {
        toast({ title: "Upload failed", variant: "error" });
      }
    } else {
      setCropState({ queue, accumulated });
    }
  };

  /** Called if the user cancels the entire crop session. */
  const handleCropCancel = () => {
    setCropExistingKey(null);
    setCropState(null);
  };

  // ── Operator-only image management ────────────────────────────────────────

  /** Move image at fromIdx to toIdx, updating imageKeys order via PATCH. */
  const handleMoveImage = async (fromIdx: number, toIdx: number) => {
    const keys: string[] = [...((product as any).imageKeys ?? [])];
    if (toIdx < 0 || toIdx >= keys.length) return;
    const [moved] = keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, moved);
    try {
      await updateProduct.mutateAsync({ id: params.id, imageKeys: keys });
      setActiveImageIdx(toIdx);
    } catch {
      toast({ title: "Reorder failed", variant: "error" });
    }
  };

  /** Move the image at index i to position 0 (making it the default/first). */
  const handleSetDefault = (i: number) => handleMoveImage(i, 0);

  /** Fetch an existing image by URL, open it in the crop modal, and replace the original on confirm. */
  const handleCropExisting = async (imageUrl: string, key: string | undefined) => {
    if (!imageUrl || !key) return;
    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const file = new File([blob], "existing-image.jpg", { type: blob.type || "image/jpeg" });
      setCropExistingKey(key);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setCropState({ queue: [file], accumulated: [] });
    } catch {
      toast({ title: "Failed to load image for cropping", variant: "error" });
    }
  };

  return (
    <>
    {/* Crop-before-upload modal — intercepts every file selection */}
    {cropState && (
      <CropModal
        file={cropState.queue[0]}
        fileIndex={cropState.accumulated.length}
        fileTotal={cropState.accumulated.length + cropState.queue.length}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
      />
    )}
    {/* Full-screen image lightbox — any user can open this */}
    {lightboxOpen && ((product as any).imageUrls?.length ?? 0) > 0 && (
      <ImageLightbox
        images={(product as any).imageUrls}
        startIndex={lightboxIdx}
        onClose={() => setLightboxOpen(false)}
      />
    )}
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/products"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Products
      </Link>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* ── Left: image gallery + stock card ── */}
        <div className="space-y-4">
          {/* ── Image gallery ── */}
          {(() => {
            const images: string[] = (product as any).imageUrls ?? [];
            const hasImages = images.length > 0;
            const safeIdx = Math.min(activeImageIdx, images.length - 1);

            const handleUpload = (files: FileList | null) => queueForCrop(files);

            const toggleSelectImage = (i: number) => {
              setSelectedImages((prev) => {
                const next = new Set(prev);
                next.has(i) ? next.delete(i) : next.add(i);
                return next;
              });
            };

            const deleteSelected = async () => {
              const keys = (product as any).imageKeys ?? [];
              const toDelete = Array.from(selectedImages).map((i) => keys[i]).filter(Boolean);
              try {
                // Delete sequentially — concurrent Prisma array-pull calls race
                // against each other and only some keys end up removed.
                for (const k of toDelete) {
                  await deleteImage.mutateAsync(k);
                }
                setSelectedImages(new Set());
                setSelectMode(false);
                setActiveImageIdx(0);
                toast({ title: `${toDelete.length} image${toDelete.length !== 1 ? "s" : ""} deleted`, variant: "success" });
              } catch {
                toast({ title: "Delete failed", variant: "error" });
              }
            };

            return (
              <div className="space-y-2">
                {/* Main image / drop zone */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleUpload(e.dataTransfer.files); }}
                  className={cn(
                    "relative overflow-hidden rounded-xl border",
                    isDragging && "ring-2 ring-brand-500",
                    !hasImages && "cursor-pointer",
                    stockStatus === "LOW" && "border-warning/30 bg-warning-bg",
                    stockStatus === "OUT_OF_STOCK" && "border-danger/30 bg-danger-bg",
                    stockStatus === "IN_STOCK" && "border-surface-border bg-surface-raised",
                  )}
                  style={{ height: "13rem" }}
                  onClick={!hasImages ? () => fileInputRef.current?.click() : undefined}
                >
                  {hasImages ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={images[safeIdx]}
                        alt={`${product.name} — image ${safeIdx + 1}`}
                        className="h-full w-full object-contain cursor-zoom-in"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLightboxIdx(safeIdx);
                          setLightboxOpen(true);
                        }}
                      />
                      {/* Delete current image (single) */}
                      {!selectMode && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            const key = (product as any).imageKeys?.[safeIdx];
                            if (!key) return;
                            try {
                              await deleteImage.mutateAsync(key);
                              setActiveImageIdx(0);
                              toast({ title: "Image deleted", variant: "success" });
                            } catch {
                              toast({ title: "Delete failed", variant: "error" });
                            }
                          }}
                          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-danger transition-colors"
                          title="Delete this image"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* Prev / next arrows */}
                      {images.length > 1 && !selectMode && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveImageIdx((i) => (i - 1 + images.length) % images.length); }}
                            className="absolute left-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveImageIdx((i) => (i + 1) % images.length); }}
                            className="absolute right-8 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </>
                      )}
                      {/* Page indicator */}
                      {images.length > 1 && !selectMode && (
                        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2 py-0.5 text-xs text-white">
                          {safeIdx + 1} / {images.length}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2">
                      <Package className={cn("h-14 w-14", stockStatus === "LOW" && "text-warning/30", stockStatus === "OUT_OF_STOCK" && "text-danger/30", stockStatus === "IN_STOCK" && "text-navy/15")} />
                      <p className="text-xs text-navy/40">Drop images here or click to upload</p>
                    </div>
                  )}
                </div>

                {/* Thumbnail strip with checkboxes in select mode */}
                {images.length > 0 && (
                  <div className="flex gap-1.5 overflow-x-auto pb-1">
                    {images.map((url, i) => (
                      <div key={i} className="relative shrink-0">
                        <button
                          onClick={() => selectMode ? toggleSelectImage(i) : setActiveImageIdx(i)}
                          className={cn(
                            "h-14 w-14 overflow-hidden rounded-lg border-2 transition-all",
                            selectMode && selectedImages.has(i) && "border-danger",
                            !selectMode && i === safeIdx ? "border-brand-500" : (!selectMode ? "border-transparent opacity-60 hover:opacity-100" : "border-surface-border"),
                          )}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={`thumb ${i + 1}`} className="h-full w-full object-cover" />
                        </button>
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selectedImages.has(i)}
                            onChange={() => toggleSelectImage(i)}
                            className="absolute left-0.5 top-0.5 h-3.5 w-3.5 cursor-pointer accent-danger"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Operator-only controls for the active image */}
                {isOperator && !selectMode && hasImages && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border pt-2">
                    {/* Move left / right */}
                    <button
                      onClick={() => handleMoveImage(safeIdx, safeIdx - 1)}
                      disabled={safeIdx === 0 || updateProduct.isPending}
                      title="Move left"
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-border text-navy/50 hover:text-navy disabled:opacity-30 transition-colors"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleMoveImage(safeIdx, safeIdx + 1)}
                      disabled={safeIdx === images.length - 1 || updateProduct.isPending}
                      title="Move right"
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-border text-navy/50 hover:text-navy disabled:opacity-30 transition-colors"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>

                    {/* Default / Set default */}
                    {safeIdx === 0 ? (
                      <span className="flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-600 select-none">
                        <Star className="h-3 w-3 fill-brand-500 text-brand-500" />
                        Default
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSetDefault(safeIdx)}
                        disabled={updateProduct.isPending}
                        title="Set as default image (move to first position)"
                        className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1 text-xs text-navy/50 hover:border-brand-200 hover:text-brand-500 disabled:opacity-30 transition-colors"
                      >
                        <Star className="h-3 w-3" />
                        Set default
                      </button>
                    )}

                    {/* Crop this image */}
                    <button
                      onClick={() => handleCropExisting(images[safeIdx], (product as any).imageKeys?.[safeIdx])}
                      disabled={!!cropState || uploadImages.isPending}
                      title="Crop this image (replaces original)"
                      className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1 text-xs text-navy/50 hover:text-navy disabled:opacity-30 transition-colors"
                    >
                      <Scissors className="h-3 w-3" />
                      Crop
                    </button>
                  </div>
                )}

                {/* Action row: select-mode toggle + bulk delete + upload */}
                <div className="flex items-center gap-2">
                  {hasImages && (
                    selectMode ? (
                      <>
                        <button
                          onClick={deleteSelected}
                          disabled={selectedImages.size === 0 || deleteImage.isPending}
                          className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-danger/90 disabled:opacity-40 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete {selectedImages.size > 0 ? `${selectedImages.size} ` : ""}selected
                        </button>
                        <button
                          onClick={() => { setSelectMode(false); setSelectedImages(new Set()); }}
                          className="rounded-lg border border-surface-border px-3 py-1.5 text-xs text-navy/60 hover:text-navy transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setSelectMode(true)}
                        className="flex items-center gap-1.5 rounded-lg border border-surface-border px-3 py-1.5 text-xs text-navy/50 hover:text-navy transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Select to delete
                      </button>
                    )
                  )}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadImages.isPending || !!cropState}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-white py-1.5 text-xs text-navy/50 hover:border-brand-500/50 hover:text-brand-500 transition-colors disabled:opacity-50"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {uploadImages.isPending ? "Uploading…" : "Upload images"}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => handleUpload(e.target.files)}
                />
              </div>
            );
          })()}

          <Card>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-navy/60">Stock status</span>
                {stockStatus === "OUT_OF_STOCK" ? (
                  <Badge variant="danger" label="Out of Stock" />
                ) : stockStatus === "LOW" ? (
                  <Badge variant="warning" label="Low Stock" />
                ) : (
                  <Badge variant="success" label="In Stock" />
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-navy/60">On hand</span>
                <span className="font-medium text-navy">
                  {currentStock.toFixed(2)} {product.unit}
                </span>
              </div>
              {product.averageCost && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-navy/60">Avg cost</span>
                  <span className="font-medium text-navy">
                    ${parseFloat(String(product.averageCost)).toFixed(2)}
                  </span>
                </div>
              )}
              <Link
                href={`/inventory/movements?product=${product.id}`}
                className="block text-xs text-brand-500 hover:underline"
              >
                View stock movements →
              </Link>
            </div>
          </Card>
        </div>

        {/* ── Right: details + chart ── */}
        <div className="space-y-5 lg:col-span-2">

          {/* Product details */}
          <Card>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <input
                    value={(editDraft.name as string) ?? ""}
                    onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-lg font-bold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                ) : (
                  <h1 className="text-xl font-bold text-navy">{product.name}</h1>
                )}
                {!isEditing && <p className="mt-1 font-mono text-xs text-navy/40">{product.sku}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      onClick={cancelEdit}
                      title="Cancel"
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    <Button
                      size="sm"
                      onClick={saveEdit}
                      loading={updateProduct.isPending}
                      leftIcon={<Check className="h-4 w-4" />}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={startEdit}
                      title="Edit product"
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => updateProduct.mutate({ id: params.id, isActive: !product.isActive })}
                      loading={updateProduct.isPending}
                    >
                      {product.isActive ? "Deactivate" : "Activate"}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <InfoRow
                label="SKU / Barcode"
                value={isEditing ? (
                  <input value={(editDraft.sku as string) ?? ""} onChange={(e) => setEditDraft((d) => ({ ...d, sku: e.target.value }))}
                    className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                ) : product.sku ?? <span className="text-navy/30">—</span>}
              />
              <InfoRow
                label="Category"
                value={isEditing ? (
                  <>
                    <input
                      list="edit-category-options"
                      value={(editDraft.category as string) ?? ""}
                      onChange={(e) => setEditDraft((d) => ({ ...d, category: e.target.value }))}
                      placeholder="Select or type a category"
                      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <datalist id="edit-category-options">
                      {catalogCategories.map((c) => <option key={c} value={c} />)}
                    </datalist>
                  </>
                ) : product.category}
              />
              <InfoRow
                label="Unit of Measure"
                value={isEditing ? (
                  <>
                    <input
                      list="edit-unit-options"
                      value={(editDraft.unit as string) ?? ""}
                      onChange={(e) => setEditDraft((d) => ({ ...d, unit: e.target.value }))}
                      placeholder="Select or type a unit"
                      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <datalist id="edit-unit-options">
                      {catalogUnits.map((u) => <option key={u} value={u} />)}
                    </datalist>
                  </>
                ) : product.unit}
              />
              <InfoRow
                label="Tier 1 Price (List)"
                value={
                  isEditing ? (
                    <EditableNumber
                      value={parseFloat(String(editDraft.pricePerUnit ?? priceNumber))}
                      onChange={(v) => setEditDraft((d) => ({ ...d, pricePerUnit: String(v) }))}
                    />
                  ) : (
                    `$${priceNumber.toFixed(2)}`
                  )
                }
              />
            </div>

            {/* Tier Prices */}
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-navy/50">Pricing Tiers</p>
                {isEditing && (
                  <button
                    type="button"
                    onClick={() => {
                      const t1 = editDraft.pricePerUnit as string;
                      setEditDraft((d) => ({
                        ...d,
                        priceTier2: t1,
                        priceTier3: t1,
                        priceTier4: t1,
                        priceTier5: t1,
                      }));
                    }}
                    className="text-xs text-brand-600 hover:underline"
                  >
                    Set all to Tier 1
                  </button>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {([
                  ["Tier 2", "priceTier2", product.priceTier2],
                  ["Tier 3", "priceTier3", product.priceTier3],
                  ["Tier 4", "priceTier4", product.priceTier4],
                  ["Tier 5", "priceTier5", product.priceTier5],
                ] as [string, string, any][]).map(([label, field, productVal]) => (
                  <div key={field}>
                    <p className="mb-1 text-xs text-navy/40">{label}</p>
                    {isEditing ? (
                      <EditableNumber
                        value={parseFloat(String(editDraft[field] ?? parseFloat(String(productVal ?? priceNumber))))}
                        onChange={(v) => setEditDraft((d) => ({ ...d, [field]: String(v) }))}
                      />
                    ) : (
                      <p className="text-sm font-medium text-navy">
                        ${parseFloat(String(productVal ?? priceNumber)).toFixed(2)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-1 text-xs text-navy/50">Description</p>
              {isEditing ? (
                <textarea
                  value={(editDraft.description as string) ?? ""}
                  onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={3}
                  className="w-full resize-y rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <p className="text-sm text-navy/80">{product.description}</p>
              )}
            </div>

          </Card>

          {/* 30-day demand chart */}
          <Card title="30-Day Order Demand">
            <p className="mb-3 text-xs text-navy/40 italic">Demo data — historical order demand coming soon.</p>
            {isMounted ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={demandData}
                  margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#e2e8f0"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "#1B3A5C99" }}
                    tickLine={false}
                    axisLine={false}
                    interval={4}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#1B3A5C99" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                      fontSize: 12,
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                    labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
                    formatter={((v: number) => [`${v} units`, "Ordered"]) as any}
                  />
                  <Bar dataKey="units" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] animate-pulse rounded-lg bg-surface-raised" />
            )}
          </Card>
        </div>
      </div>
    </div>
    </>
  );
}
