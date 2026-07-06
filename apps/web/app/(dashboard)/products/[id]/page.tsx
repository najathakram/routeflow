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
  Plus,
  Power,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Modal, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import {
  useProduct,
  useProducts,
  useUpdateProduct,
  useDeleteProduct,
  useUploadProductImages,
  useDeleteProductImage,
  useCreateProduct,
  type ApiProduct,
} from "@/lib/api/products";
import { useCostHistory } from "@/lib/api/cost-history";
import { apiClient } from "@/lib/api-client";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { useAuth } from "@/lib/auth-context";
import { useHasAddon, TOBACCO_ADDON } from "@/lib/api/tobacco";
import { CropModal } from "./CropModal";
import { ImageLightbox } from "./ImageLightbox";
import { objectPositionForUrl, type FocalPoint } from "@/lib/image-focal";

const COMMON_UNITS = [
  "unit",
  "each",
  "case",
  "box",
  "bag",
  "pack",
  "dozen",
  "pallet",
  "kg",
  "g",
  "lb",
  "oz",
  "L",
  "ml",
  "tray",
  "bottle",
  "can",
  "roll",
  "sheet",
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
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">{label}</p>
      <div className="mt-1 text-sm font-medium text-navy">{value}</div>
    </div>
  );
}

// ─── Inline number field ──────────────────────────────────────────────────────

function EditableNumber({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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

function CostHistoryCard({ productId }: { productId: string }) {
  const { data: history = [] } = useCostHistory(productId);

  if (history.length === 0) return null;

  const chartData = history.map((h) => ({
    date: new Date(h.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    purchaseCost: h.unitCost,
    avgCost: h.avgCostAfter,
    type: h.type,
  }));

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="border-b border-surface-border px-5 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Purchase Cost History
        </h3>
      </div>
      <div className="p-5">
        <p className="mb-3 text-xs text-navy/70">
          Unit cost of each purchase (and manual cost-basis entries) with the running average cost.
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${v}`}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                fontSize: 12,
                boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
              }}
              labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
              formatter={
                ((v: number, name: string) => [
                  `$${Number(v).toFixed(4)}`,
                  name === "purchaseCost" ? "Purchase cost" : "Avg cost after",
                ]) as any
              }
            />
            <Line
              type="stepAfter"
              dataKey="avgCost"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="purchaseCost"
              stroke="#f59e0b"
              strokeWidth={0}
              dot={{ r: 3, fill: "#f59e0b" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data: product, isLoading } = useProduct(params.id);
  const { data: allProductsResult } = useProducts({ limit: 0 });
  const updateProduct = useUpdateProduct();
  const createProduct = useCreateProduct();
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

  // ── Variant modal state ──────────────────────────────────────────────────
  const [variantModalOpen, setVariantModalOpen] = React.useState(false);
  const [editingVariant, setEditingVariant] = React.useState<ApiProduct | null>(null);
  const [variantForm, setVariantForm] = React.useState({
    variantName: "",
    sku: "",
    price: "",
    unit: "",
    priceTier2: "",
    priceTier3: "",
    priceTier4: "",
    priceTier5: "",
  });
  const variantSkuRef = React.useRef<HTMLInputElement>(null);

  // ── "Make variant of" modal state ────────────────────────────────────────
  const [makeVariantOpen, setMakeVariantOpen] = React.useState(false);
  const [makeVariantParentId, setMakeVariantParentId] = React.useState("");
  const [makeVariantName, setMakeVariantName] = React.useState("");
  const [makeVariantScanLoading, setMakeVariantScanLoading] = React.useState(false);
  const [makeVariantParentOwnName, setMakeVariantParentOwnName] = React.useState("");

  // ── "Link existing product as variant" modal state ──────────────────────
  const [linkExistingOpen, setLinkExistingOpen] = React.useState(false);
  const [linkExistingProductId, setLinkExistingProductId] = React.useState("");
  const [linkExistingVariantName, setLinkExistingVariantName] = React.useState("");
  const [linkExistingParentVariantName, setLinkExistingParentVariantName] = React.useState("");
  const [linkExistingSearch, setLinkExistingSearch] = React.useState("");

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";
  const hasTobaccoAddon = useHasAddon(TOBACCO_ADDON);

  // ── Lightbox state ────────────────────────────────────────────────────────
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [lightboxIdx, setLightboxIdx] = React.useState(0);

  // ── Crop-existing state ───────────────────────────────────────────────────
  // When set, the next crop completion replaces this key instead of adding a new image
  const [cropExistingKey, setCropExistingKey] = React.useState<string | null>(null);

  // ── Crop-before-upload state ──────────────────────────────────────────────
  // When the user picks files we queue them here; CropModal works through them
  // one-by-one (crop → focal point per file). Once the queue is empty the
  // cropped blobs and their focal points are uploaded together.
  const [cropState, setCropState] = React.useState<{
    queue: File[];
    accumulated: Array<{ blob: Blob; focal: FocalPoint }>;
  } | null>(null);

  // Derived: all known categories and units from the catalog
  const allProducts: any[] = allProductsResult?.data ?? [];
  const catalogCategories = Array.from(
    new Set(allProducts.map((p: any) => p.category).filter(Boolean)),
  ) as string[];
  const catalogUnits = Array.from(
    new Set([...COMMON_UNITS, ...allProducts.map((p: any) => p.unit).filter(Boolean)]),
  ).sort() as string[];

  // Standalone products eligible as parents in the "Variant of" edit dropdown
  const variantOfCandidates = allProducts.filter(
    (p: any) => !p.parentProductId && p.id !== params.id,
  );

  // Reset active image index if images change
  React.useEffect(() => {
    setActiveImageIdx(0);
  }, [product?.id]);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);
  React.useEffect(() => {
    setTitle(product?.name ?? "Product");
  }, [setTitle, product?.name]);

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-navy/70">Loading...</div>;
  }

  if (!product) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Product not found.</p>
        <Button variant="secondary" href="/products">
          Back to Products
        </Button>
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
      parentProductId: product.parentProductId ?? "",
      variantName: product.variantName ?? "",
    });
    setIsEditing(true);
  };

  const saveEdit = () => {
    const selectedParent = (editDraft.parentProductId as string)
      ? allProducts.find((p: any) => p.id === editDraft.parentProductId)
      : null;
    const composedName =
      selectedParent && (editDraft.variantName as string)?.trim()
        ? `${(selectedParent as any).name} - ${(editDraft.variantName as string).trim()}`
        : (editDraft.name as string);
    updateProduct.mutate({ id: params.id, ...editDraft, name: composedName });
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
    // FileList is a live reference to the input's files; copy it BEFORE
    // clearing the input value, otherwise the array becomes empty.
    const queue = Array.from(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setCropState({ queue, accumulated: [] });
  };

  /** Called by CropModal each time the user confirms one crop + focal. */
  const handleCropConfirm = async (blob: Blob, focal: FocalPoint) => {
    if (!cropState) return;
    const accumulated = [...cropState.accumulated, { blob, focal }];
    const queue = cropState.queue.slice(1);

    if (queue.length === 0) {
      setCropState(null);
      try {
        if (cropExistingKey) {
          // Replacing an existing image: upload cropped version first, then remove original.
          const { blob: b, focal: f } = accumulated[0];
          const file = new File([b], `product-image-${Date.now()}.jpg`, { type: "image/jpeg" });
          await uploadImages.mutateAsync({ files: [file], focals: [f] });
          await deleteImage.mutateAsync(cropExistingKey);
          setCropExistingKey(null);
          toast({ title: "Image cropped and replaced", variant: "success" });
        } else {
          // Normal upload flow — upload all cropped blobs with their focals.
          const files = accumulated.map(
            ({ blob: b }, i) =>
              new File([b], `product-image-${Date.now()}-${i}.jpg`, { type: "image/jpeg" }),
          );
          const focals = accumulated.map(({ focal: f }) => f);
          await uploadImages.mutateAsync({ files, focals });
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

  // ── Variant helpers ─────────────────────────────────────────────────────

  const openVariantModal = (variant?: ApiProduct) => {
    if (variant) {
      const vp = parseFloat(String(variant.pricePerUnit));
      setEditingVariant(variant);
      setVariantForm({
        variantName: variant.variantName ?? "",
        sku: variant.sku ?? "",
        price: String(vp),
        unit: variant.unit ?? product.unit,
        priceTier2: String(parseFloat(String((variant as any).priceTier2 ?? vp))),
        priceTier3: String(parseFloat(String((variant as any).priceTier3 ?? vp))),
        priceTier4: String(parseFloat(String((variant as any).priceTier4 ?? vp))),
        priceTier5: String(parseFloat(String((variant as any).priceTier5 ?? vp))),
      });
    } else {
      setEditingVariant(null);
      setVariantForm({
        variantName: "",
        sku: "",
        price: String(priceNumber),
        unit: product.unit,
        priceTier2: String(parseFloat(String((product as any).priceTier2 ?? priceNumber))),
        priceTier3: String(parseFloat(String((product as any).priceTier3 ?? priceNumber))),
        priceTier4: String(parseFloat(String((product as any).priceTier4 ?? priceNumber))),
        priceTier5: String(parseFloat(String((product as any).priceTier5 ?? priceNumber))),
      });
    }
    setVariantModalOpen(true);
  };

  const closeVariantModal = () => {
    setVariantModalOpen(false);
    setEditingVariant(null);
  };

  const handleVariantSubmit = () => {
    if (!variantForm.variantName.trim()) {
      toast({ title: "Variant name is required", variant: "error" });
      return;
    }
    if (editingVariant) {
      updateProduct.mutate(
        {
          id: editingVariant.id,
          variantName: variantForm.variantName,
          sku: variantForm.sku || undefined,
          pricePerUnit: variantForm.price,
          priceTier2: variantForm.priceTier2,
          priceTier3: variantForm.priceTier3,
          priceTier4: variantForm.priceTier4,
          priceTier5: variantForm.priceTier5,
        },
        {
          onSuccess: () => {
            toast({ title: "Variant updated", variant: "success" });
            closeVariantModal();
          },
          onError: () => toast({ title: "Failed to update variant", variant: "error" }),
        },
      );
    } else {
      createProduct.mutate(
        {
          // `name` stores only the variant name; parent context comes from
          // `parentProductId`. UI composes the display name when needed.
          name: variantForm.variantName,
          parentProductId: product.id,
          variantName: variantForm.variantName,
          sku: variantForm.sku || undefined,
          unit: variantForm.unit || product.unit,
          pricePerUnit: variantForm.price || String(product.pricePerUnit),
          priceTier2: variantForm.priceTier2 || variantForm.price || String(product.pricePerUnit),
          priceTier3: variantForm.priceTier3 || variantForm.price || String(product.pricePerUnit),
          priceTier4: variantForm.priceTier4 || variantForm.price || String(product.pricePerUnit),
          priceTier5: variantForm.priceTier5 || variantForm.price || String(product.pricePerUnit),
          category: product.category || undefined,
        },
        {
          onSuccess: () => {
            toast({ title: "Variant created", variant: "success" });
            closeVariantModal();
          },
          onError: () => toast({ title: "Failed to create variant", variant: "error" }),
        },
      );
    }
  };

  const handleToggleVariantActive = (variant: ApiProduct) => {
    if (variant.isActive) {
      if (!window.confirm("Deactivate this variant?")) return;
      updateProduct.mutate(
        { id: variant.id, isActive: false },
        { onSuccess: () => toast({ title: "Variant deactivated", variant: "success" }) },
      );
    } else {
      updateProduct.mutate(
        { id: variant.id, isActive: true },
        { onSuccess: () => toast({ title: "Variant reactivated", variant: "success" }) },
      );
    }
  };

  // ── "Make variant of" helpers ─────────────────────────────────────────────

  const openMakeVariantModal = () => {
    setMakeVariantParentId("");
    setMakeVariantName(product.variantName ?? "");
    setMakeVariantParentOwnName("");
    setMakeVariantOpen(true);
  };

  const handleMakeVariantScan = async (code: string) => {
    setMakeVariantScanLoading(true);
    try {
      const found = await apiClient
        .get(`/products/barcode/${encodeURIComponent(code)}`)
        .then((r) => r.data);
      // If the scanned product is itself a variant, resolve to its parent
      const parentId: string = found.parentProductId || found.id;
      // Don't allow linking to self
      if (parentId === params.id) {
        toast({ title: "Cannot link a product to itself", variant: "error" });
        return;
      }
      setMakeVariantParentId(parentId);
    } catch {
      toast({ title: "Product not found for that barcode", variant: "error" });
    } finally {
      setMakeVariantScanLoading(false);
    }
  };

  const handleMakeVariantSubmit = () => {
    if (!makeVariantParentId) {
      toast({ title: "Please select a parent product", variant: "error" });
      return;
    }
    if (!makeVariantName.trim()) {
      toast({ title: "Flavor / variety name is required", variant: "error" });
      return;
    }
    const parentProduct = allProducts.find((p: any) => p.id === makeVariantParentId) as any;
    const baseName = parentProduct?.name ?? product.name;
    const newName = `${baseName} - ${makeVariantName.trim()}`;

    // If the parent has no variantName yet, assign it one first
    const parentNeedsName =
      parentProduct && !parentProduct.variantName && makeVariantParentOwnName.trim();
    const doLink = () =>
      updateProduct.mutate(
        {
          id: params.id,
          parentProductId: makeVariantParentId,
          variantName: makeVariantName.trim(),
          name: newName,
        },
        {
          onSuccess: () => {
            toast({ title: "Product linked as variant", variant: "success" });
            setMakeVariantOpen(false);
          },
          onError: () => toast({ title: "Failed to link as variant", variant: "error" }),
        },
      );

    if (parentNeedsName) {
      const parentNewName = `${baseName} - ${makeVariantParentOwnName.trim()}`;
      updateProduct.mutate(
        {
          id: makeVariantParentId,
          variantName: makeVariantParentOwnName.trim(),
          name: parentNewName,
        },
        {
          onSuccess: doLink,
          onError: () => toast({ title: "Failed to update parent variant name", variant: "error" }),
        },
      );
    } else {
      doLink();
    }
  };

  // ── "Link existing product as variant" helpers ────────────────────────────

  const openLinkExistingModal = () => {
    setLinkExistingProductId("");
    setLinkExistingVariantName("");
    setLinkExistingParentVariantName(product.variantName ?? "");
    setLinkExistingSearch("");
    setLinkExistingOpen(true);
  };

  // Derive filterable candidates: standalone products that aren't already variants of this product
  const existingVariantIds = new Set((product?.variants ?? []).map((v: any) => v.id));
  const linkCandidates = allProducts.filter(
    (p: any) =>
      !p.parentProductId && // standalone only
      p.id !== params.id && // not self
      !existingVariantIds.has(p.id), // not already a variant of this product
  );
  const filteredLinkCandidates = linkExistingSearch
    ? linkCandidates.filter(
        (p: any) =>
          p.name.toLowerCase().includes(linkExistingSearch.toLowerCase()) ||
          (p.sku && p.sku.toLowerCase().includes(linkExistingSearch.toLowerCase())),
      )
    : linkCandidates;

  const handleLinkExistingSubmit = () => {
    if (!linkExistingProductId) {
      toast({ title: "Please select a product", variant: "error" });
      return;
    }
    if (!linkExistingVariantName.trim()) {
      toast({ title: "Flavor / variety name is required", variant: "error" });
      return;
    }
    const baseName = product.name;
    const composedName = `${baseName} - ${linkExistingVariantName.trim()}`;

    // Link the selected product as a child variant
    const doLinkChild = () =>
      updateProduct.mutate(
        {
          id: linkExistingProductId,
          parentProductId: product.id,
          variantName: linkExistingVariantName.trim(),
          name: composedName,
        },
        {
          onSuccess: () => {
            toast({ title: "Product linked as variant", variant: "success" });
            setLinkExistingOpen(false);
          },
          onError: () => toast({ title: "Failed to link product", variant: "error" }),
        },
      );

    // If the current (parent) product has no variantName yet, assign it one first
    const parentNeedsName = !product.variantName && linkExistingParentVariantName.trim();
    if (parentNeedsName) {
      const parentNewName = `${baseName} - ${linkExistingParentVariantName.trim()}`;
      updateProduct.mutate(
        { id: product.id, variantName: linkExistingParentVariantName.trim(), name: parentNewName },
        {
          onSuccess: doLinkChild,
          onError: () => toast({ title: "Failed to update parent variant name", variant: "error" }),
        },
      );
    } else {
      doLinkChild();
    }
  };

  // ── Unlink from parent ────────────────────────────────────────────────────

  const handleUnlinkFromParent = () => {
    if (
      !window.confirm(
        "Unlink this product from its parent? It will become a standalone product again.",
      )
    )
      return;
    updateProduct.mutate(
      { id: params.id, parentProductId: null, variantName: null },
      {
        onSuccess: () => toast({ title: "Product unlinked — now standalone", variant: "success" }),
        onError: () => toast({ title: "Failed to unlink", variant: "error" }),
      },
    );
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
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Products
        </Link>

        {/* Page header — name, status badges, provenance line */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-[-0.01em] text-navy">{product.name}</h1>
              <Badge
                variant={product.isActive ? "success" : "neutral"}
                label={product.isActive ? "Active" : "Inactive"}
              />
              {stockStatus === "OUT_OF_STOCK" ? (
                <Badge variant="danger" label="Out of Stock" />
              ) : stockStatus === "LOW" ? (
                <Badge variant="warning" label="Low Stock" />
              ) : null}
              {(product as any).isTobacco && <Badge variant="warning" label="Tobacco" />}
            </div>
            <p className="mt-1.5 text-sm text-navy/70">
              {product.sku && <span className="font-mono">{product.sku}</span>}
              {product.sku && (product.category || product.parent) ? " · " : ""}
              {product.parent ? `Variant of ${product.parent.name}` : product.category}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* ── Left: image gallery + stock card ── */}
          <div className="space-y-4">
            {/* ── Image gallery ── */}
            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="border-b border-surface-border px-4 py-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  Image
                </h3>
              </div>
              <div className="p-4">
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
                    const toDelete = Array.from(selectedImages)
                      .map((i) => keys[i])
                      .filter(Boolean);
                    try {
                      // Delete sequentially — concurrent Prisma array-pull calls race
                      // against each other and only some keys end up removed.
                      for (const k of toDelete) {
                        await deleteImage.mutateAsync(k);
                      }
                      setSelectedImages(new Set());
                      setSelectMode(false);
                      setActiveImageIdx(0);
                      toast({
                        title: `${toDelete.length} image${toDelete.length !== 1 ? "s" : ""} deleted`,
                        variant: "success",
                      });
                    } catch {
                      toast({ title: "Delete failed", variant: "error" });
                    }
                  };

                  return (
                    <div className="space-y-2">
                      {/* Main image / drop zone — 4:5 portrait viewport matching the
                    upload ratio. object-cover + object-position uses each
                    image's stored focal point to keep the right area visible
                    even when the image is from before the focal-point
                    feature (those default to centre). */}
                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          setIsDragging(true);
                        }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setIsDragging(false);
                          handleUpload(e.dataTransfer.files);
                        }}
                        className={cn(
                          "relative aspect-[4/5] w-full overflow-hidden rounded-xl border",
                          isDragging && "ring-2 ring-brand-500",
                          !hasImages && "cursor-pointer",
                          stockStatus === "LOW" && "border-warning/30 bg-warning-bg",
                          stockStatus === "OUT_OF_STOCK" && "border-danger/30 bg-danger-bg",
                          stockStatus === "IN_STOCK" && "border-surface-border bg-surface-raised",
                        )}
                        onClick={!hasImages ? () => fileInputRef.current?.click() : undefined}
                      >
                        {hasImages ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={images[safeIdx]}
                              alt={`${product.name} — image ${safeIdx + 1}`}
                              className="absolute inset-0 h-full w-full object-cover cursor-zoom-in"
                              style={{ objectPosition: objectPositionForUrl(images[safeIdx]) }}
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveImageIdx(
                                      (i) => (i - 1 + images.length) % images.length,
                                    );
                                  }}
                                  className="absolute left-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
                                >
                                  <ChevronLeft className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveImageIdx((i) => (i + 1) % images.length);
                                  }}
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
                            <Package
                              className={cn(
                                "h-14 w-14",
                                stockStatus === "LOW" && "text-warning/30",
                                stockStatus === "OUT_OF_STOCK" && "text-danger/30",
                                stockStatus === "IN_STOCK" && "text-navy/15",
                              )}
                            />
                            <p className="text-xs text-navy/70">
                              Drop images here or click to upload
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Thumbnail strip with checkboxes in select mode */}
                      {images.length > 0 && (
                        <div className="flex gap-1.5 overflow-x-auto pb-1">
                          {images.map((url, i) => (
                            <div key={i} className="relative shrink-0">
                              <button
                                onClick={() =>
                                  selectMode ? toggleSelectImage(i) : setActiveImageIdx(i)
                                }
                                className={cn(
                                  "h-14 w-14 overflow-hidden rounded-lg border-2 transition-all",
                                  selectMode && selectedImages.has(i) && "border-danger",
                                  !selectMode && i === safeIdx
                                    ? "border-brand-500"
                                    : !selectMode
                                      ? "border-transparent opacity-60 hover:opacity-100"
                                      : "border-surface-border",
                                )}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={url}
                                  alt={`thumb ${i + 1}`}
                                  className="h-full w-full object-cover"
                                  style={{ objectPosition: objectPositionForUrl(url) }}
                                />
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
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-border text-navy/70 hover:text-navy disabled:opacity-30 transition-colors"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleMoveImage(safeIdx, safeIdx + 1)}
                            disabled={safeIdx === images.length - 1 || updateProduct.isPending}
                            title="Move right"
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-border text-navy/70 hover:text-navy disabled:opacity-30 transition-colors"
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
                              className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1 text-xs text-navy/70 hover:border-brand-200 hover:text-brand-500 disabled:opacity-30 transition-colors"
                            >
                              <Star className="h-3 w-3" />
                              Set default
                            </button>
                          )}

                          {/* Crop / re-set focal — re-runs the crop + focal-point
                        flow on the existing image and replaces the original. */}
                          <button
                            onClick={() =>
                              handleCropExisting(
                                images[safeIdx],
                                (product as any).imageKeys?.[safeIdx],
                              )
                            }
                            disabled={!!cropState || uploadImages.isPending}
                            title="Re-crop and/or move the focal point (replaces the original image)"
                            className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1 text-xs text-navy/70 hover:text-navy disabled:opacity-30 transition-colors"
                          >
                            <Scissors className="h-3 w-3" />
                            Crop / focal
                          </button>
                        </div>
                      )}

                      {/* Action row: select-mode toggle + bulk delete + upload */}
                      <div className="flex items-center gap-2">
                        {hasImages &&
                          (selectMode ? (
                            <>
                              <button
                                onClick={deleteSelected}
                                disabled={selectedImages.size === 0 || deleteImage.isPending}
                                className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-danger/90 disabled:opacity-40 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete {selectedImages.size > 0 ? `${selectedImages.size} ` : ""}
                                selected
                              </button>
                              <button
                                onClick={() => {
                                  setSelectMode(false);
                                  setSelectedImages(new Set());
                                }}
                                className="rounded-lg border border-surface-border px-3 py-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setSelectMode(true)}
                              className="flex items-center gap-1.5 rounded-lg border border-surface-border px-3 py-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Select to delete
                            </button>
                          ))}
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadImages.isPending || !!cropState}
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-white py-1.5 text-xs text-navy/70 hover:border-brand-500/50 hover:text-brand-500 transition-colors disabled:opacity-50"
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
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="border-b border-surface-border px-4 py-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  Stock &amp; Cost
                </h3>
              </div>
              <div className="px-4">
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">Stock status</span>
                  {stockStatus === "OUT_OF_STOCK" ? (
                    <Badge variant="danger" label="Out of Stock" />
                  ) : stockStatus === "LOW" ? (
                    <Badge variant="warning" label="Low Stock" />
                  ) : (
                    <Badge variant="success" label="In Stock" />
                  )}
                </div>
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">On hand</span>
                  <span className="font-mono font-medium tabular-nums text-navy">
                    {currentStock.toFixed(2)} {product.unit}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">Avg cost</span>
                  {product.averageCost != null ? (
                    <span className="font-mono font-medium tabular-nums text-navy">
                      ${parseFloat(String(product.averageCost)).toFixed(2)}
                    </span>
                  ) : (
                    <span
                      title="No cost basis recorded — set one from Inventory → Set Costs, or receive a purchase"
                      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                    >
                      No cost set
                    </span>
                  )}
                </div>
                <Link
                  href={`/inventory/movements?product=${product.id}`}
                  className="block py-3 text-xs font-semibold text-brand-600 hover:underline"
                >
                  View stock movements →
                </Link>
              </div>
            </div>
          </div>

          {/* ── Right: details + chart ── */}
          <div className="space-y-5 lg:col-span-2">
            {/* Product details */}
            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-5 py-3.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  Details
                </h3>
                <div className="flex shrink-0 items-center gap-2">
                  {isEditing ? (
                    <>
                      <button
                        onClick={cancelEdit}
                        title="Cancel"
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
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
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {isOperator && !product.parentProductId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={openMakeVariantModal}
                          title="Link this product as a variant of another product"
                        >
                          Make variant of…
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateProduct.mutate({ id: params.id, isActive: !product.isActive })
                        }
                        loading={updateProduct.isPending}
                      >
                        {product.isActive ? "Deactivate" : "Activate"}
                      </Button>
                      {hasTobaccoAddon && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            updateProduct.mutate({
                              id: params.id,
                              isTobacco: !(product as any).isTobacco,
                            } as any)
                          }
                          loading={updateProduct.isPending}
                          title="Tobacco products are tracked separately for monthly tax reports"
                        >
                          {(product as any).isTobacco ? "Unmark tobacco" : "Mark as tobacco"}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="p-5">
                {/* Edit-mode name field — view mode shows the name in the page header */}
                {isEditing && (
                  <div className="mb-4">
                    {(() => {
                      const editParent = (editDraft.parentProductId as string)
                        ? allProducts.find((p: any) => p.id === editDraft.parentProductId)
                        : null;
                      const previewName =
                        editParent && (editDraft.variantName as string)?.trim()
                          ? `${(editParent as any).name} - ${(editDraft.variantName as string).trim()}`
                          : null;
                      return editParent ? (
                        <div>
                          <p className="w-full rounded border border-surface-border bg-surface-raised px-2 py-1 text-lg font-bold text-navy/70 select-none">
                            {previewName ?? (
                              <span className="text-navy/30 italic text-sm font-normal">
                                auto-composed from parent + flavor
                              </span>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-navy/70 italic">
                            Name auto-composed from parent + flavor
                          </p>
                        </div>
                      ) : (
                        <input
                          value={(editDraft.name as string) ?? ""}
                          onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                          className="w-full rounded border border-surface-border px-2 py-1 text-lg font-bold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      );
                    })()}
                  </div>
                )}

                {/* Tobacco compliance banner */}
                {(product as any).isTobacco && (
                  <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-2">
                    <p className="text-sm text-amber-900">
                      <span className="font-semibold">Tobacco product</span> — purchases and sales
                      are tracked separately for monthly tax reports.
                    </p>
                    <Link href="/tobacco" className="text-xs font-medium text-amber-800 underline">
                      Tobacco section →
                    </Link>
                  </div>
                )}

                {/* Parent link banner for variants */}
                {product.parentProductId && product.parent && (
                  <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 mb-4">
                    <p className="text-sm text-blue-700">
                      This is a variant of{" "}
                      <Link
                        href={`/products/${product.parentProductId}`}
                        className="font-medium underline"
                      >
                        {product.parent.name}
                      </Link>
                    </p>
                    {isOperator && (
                      <button
                        onClick={handleUnlinkFromParent}
                        className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        Unlink
                      </button>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <InfoRow
                    label="SKU / Barcode"
                    value={
                      isEditing ? (
                        <input
                          value={(editDraft.sku as string) ?? ""}
                          onChange={(e) => setEditDraft((d) => ({ ...d, sku: e.target.value }))}
                          className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      ) : (
                        (product.sku ?? <span className="text-navy/30">—</span>)
                      )
                    }
                  />
                  <InfoRow
                    label="Category"
                    value={
                      isEditing ? (
                        <>
                          <input
                            list="edit-category-options"
                            value={(editDraft.category as string) ?? ""}
                            onChange={(e) =>
                              setEditDraft((d) => ({ ...d, category: e.target.value }))
                            }
                            placeholder="Select or type a category"
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <datalist id="edit-category-options">
                            {catalogCategories.map((c) => (
                              <option key={c} value={c} />
                            ))}
                          </datalist>
                        </>
                      ) : (
                        product.category
                      )
                    }
                  />
                  <InfoRow
                    label="Unit of Measure"
                    value={
                      isEditing ? (
                        <>
                          <input
                            list="edit-unit-options"
                            value={(editDraft.unit as string) ?? ""}
                            onChange={(e) => setEditDraft((d) => ({ ...d, unit: e.target.value }))}
                            placeholder="Select or type a unit"
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <datalist id="edit-unit-options">
                            {catalogUnits.map((u) => (
                              <option key={u} value={u} />
                            ))}
                          </datalist>
                        </>
                      ) : (
                        product.unit
                      )
                    }
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
                        <span className="font-mono tabular-nums">${priceNumber.toFixed(2)}</span>
                      )
                    }
                  />
                  {/* Variant of — always show when editing; in view mode show only if product has a parent */}
                  {(isEditing || product.parentProductId) && (
                    <InfoRow
                      label="Variant of"
                      value={
                        isEditing ? (
                          <select
                            value={(editDraft.parentProductId as string) ?? ""}
                            onChange={(e) =>
                              setEditDraft((d) => ({
                                ...d,
                                parentProductId: e.target.value,
                                variantName: e.target.value ? (d.variantName as string) : "",
                              }))
                            }
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="">None (standalone product)</option>
                            {variantOfCandidates.map((p: any) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                                {p.sku ? ` — ${p.sku}` : ""}
                              </option>
                            ))}
                          </select>
                        ) : product.parent ? (
                          <Link
                            href={`/products/${product.parentProductId}`}
                            className="text-brand-600 underline text-sm"
                          >
                            {product.parent.name}
                          </Link>
                        ) : (
                          "—"
                        )
                      }
                    />
                  )}
                  {/* Flavor / variety — only when a parent is selected */}
                  {isEditing && (editDraft.parentProductId as string) && (
                    <InfoRow
                      label="Flavor / variety"
                      value={
                        <div>
                          <input
                            value={(editDraft.variantName as string) ?? ""}
                            onChange={(e) =>
                              setEditDraft((d) => ({ ...d, variantName: e.target.value }))
                            }
                            placeholder="e.g. Large, Strawberry, Red…"
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          {(editDraft.variantName as string)?.trim() &&
                            (() => {
                              const p = allProducts.find(
                                (x: any) => x.id === editDraft.parentProductId,
                              ) as any;
                              return p ? (
                                <p className="mt-1 text-xs text-navy/70 italic">
                                  Name will be: &ldquo;{p.name} -{" "}
                                  {(editDraft.variantName as string).trim()}&rdquo;
                                </p>
                              ) : null;
                            })()}
                        </div>
                      }
                    />
                  )}
                </div>

                {/* Tier Prices */}
                <div className="mt-5 border-t border-surface-border pt-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                      Pricing Tiers
                    </p>
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
                    {(
                      [
                        ["Tier 2", "priceTier2", product.priceTier2],
                        ["Tier 3", "priceTier3", product.priceTier3],
                        ["Tier 4", "priceTier4", product.priceTier4],
                        ["Tier 5", "priceTier5", product.priceTier5],
                      ] as [string, string, any][]
                    ).map(([label, field, productVal], idx) => {
                      const prevFields = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4"];
                      const prevField = prevFields[idx];
                      const curVal = isEditing
                        ? parseFloat(
                            String(
                              editDraft[field] ?? parseFloat(String(productVal ?? priceNumber)),
                            ),
                          )
                        : parseFloat(String(productVal ?? priceNumber));
                      const prevVal = isEditing
                        ? parseFloat(String(editDraft[prevField] ?? priceNumber))
                        : parseFloat(
                            String(
                              idx === 0
                                ? priceNumber
                                : ((product as any)[prevField] ?? priceNumber),
                            ),
                          );
                      const warn = isEditing && curVal > prevVal;
                      return (
                        <div key={field}>
                          <p
                            className={cn(
                              "mb-1 text-xs",
                              warn ? "text-warning font-medium" : "text-navy/70",
                            )}
                          >
                            {label}
                            {warn ? " ⚠" : ""}
                          </p>
                          {isEditing ? (
                            <EditableNumber
                              value={curVal}
                              onChange={(v) => setEditDraft((d) => ({ ...d, [field]: String(v) }))}
                            />
                          ) : (
                            <p className="font-mono text-sm font-medium tabular-nums text-navy">
                              ${parseFloat(String(productVal ?? priceNumber)).toFixed(2)}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {isEditing &&
                    (() => {
                      const t1 = parseFloat(String(editDraft.pricePerUnit ?? priceNumber));
                      const t2 = parseFloat(
                        String(editDraft.priceTier2 ?? (product as any).priceTier2 ?? t1),
                      );
                      const t3 = parseFloat(
                        String(editDraft.priceTier3 ?? (product as any).priceTier3 ?? t1),
                      );
                      const t4 = parseFloat(
                        String(editDraft.priceTier4 ?? (product as any).priceTier4 ?? t1),
                      );
                      const t5 = parseFloat(
                        String(editDraft.priceTier5 ?? (product as any).priceTier5 ?? t1),
                      );
                      const hasViolation = t2 > t1 || t3 > t2 || t4 > t3 || t5 > t4;
                      return hasViolation ? (
                        <p className="mt-1.5 text-xs text-warning">
                          Higher tier prices should be ≤ the tier above (volume discounts are
                          lower).
                        </p>
                      ) : null;
                    })()}
                </div>

                <div className="mt-5 border-t border-surface-border pt-4">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                    Description
                  </p>
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
              </div>
            </div>

            {/* 30-day demand chart */}
            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="border-b border-surface-border px-5 py-3.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  30-Day Order Demand
                </h3>
              </div>
              <div className="p-5">
                <p className="mb-3 text-xs text-navy/70 italic">
                  Demo data — historical order demand coming soon.
                </p>
                {isMounted ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={demandData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
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
              </div>
            </div>

            {/* Purchase cost history — real data from PURCHASE / COST_BASIS movements */}
            <CostHistoryCard productId={product.id} />

            {/* Variants section — only for non-variant (parent) products */}
            {!product.parentProductId && (
              <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-5 py-3.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                    Variants
                  </h3>
                  {isOperator && (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={openLinkExistingModal}>
                        Link existing
                      </Button>
                      <Button
                        size="sm"
                        leftIcon={<Plus className="h-3.5 w-3.5" />}
                        onClick={() => openVariantModal()}
                      >
                        Add Variant
                      </Button>
                    </div>
                  )}
                </div>

                {(!product.variants || product.variants.length === 0) && !product.variantName ? (
                  <p className="text-sm text-navy/70 text-center py-10">
                    No variants yet. Add flavors, sizes, or other variations.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left">
                          <th className="border-b-2 border-navy px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            Variant
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            SKU
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            Tier 1
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            Tier 2
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            Status
                          </th>
                          {isOperator && (
                            <th className="border-b-2 border-navy px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                              Actions
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {/* Parent product itself as first row */}
                        <tr className="border-b border-surface-border bg-surface-raised/30">
                          <td className="px-5 py-2.5">
                            <span className="font-medium text-navy">
                              {product.variantName || (
                                <span className="italic text-navy/70">this product</span>
                              )}
                            </span>
                            {!product.variantName && isOperator && (
                              <button
                                onClick={startEdit}
                                className="ml-2 text-xs text-brand-500 hover:underline"
                              >
                                assign name
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-navy/70">
                            {product.sku || <span className="text-navy/30">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                            ${priceNumber.toFixed(2)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                            $
                            {parseFloat(String((product as any).priceTier2 ?? priceNumber)).toFixed(
                              2,
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge
                              variant={product.isActive ? "success" : "neutral"}
                              label={product.isActive ? "Active" : "Inactive"}
                            />
                          </td>
                          {isOperator && (
                            <td className="px-5 py-2.5 text-right">
                              <button
                                onClick={startEdit}
                                title="Edit this product"
                                className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                        {(product.variants ?? []).map((variant: ApiProduct) => (
                          <tr
                            key={variant.id}
                            className="border-b border-surface-border last:border-0"
                          >
                            <td className="px-5 py-2.5">
                              <Link
                                href={`/products/${variant.id}`}
                                className="font-medium text-brand-600 hover:underline"
                              >
                                {variant.variantName || variant.name}
                              </Link>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-navy/70">
                              {variant.sku || <span className="text-navy/30">&mdash;</span>}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                              ${parseFloat(String(variant.pricePerUnit)).toFixed(2)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                              $
                              {parseFloat(
                                String((variant as any).priceTier2 ?? variant.pricePerUnit),
                              ).toFixed(2)}
                            </td>
                            <td className="px-3 py-2.5">
                              <Badge
                                variant={variant.isActive ? "success" : "neutral"}
                                label={variant.isActive ? "Active" : "Inactive"}
                              />
                            </td>
                            {isOperator && (
                              <td className="px-5 py-2.5">
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={() => openVariantModal(variant)}
                                    title="Edit variant"
                                    className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleToggleVariantActive(variant)}
                                    title={variant.isActive ? "Deactivate" : "Reactivate"}
                                    className={cn(
                                      "rounded p-1.5 transition-colors",
                                      variant.isActive
                                        ? "text-navy/70 hover:bg-warning-bg hover:text-warning"
                                        : "text-navy/70 hover:bg-success-bg hover:text-success",
                                    )}
                                  >
                                    <Power className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Variant Add/Edit Modal */}
      <Modal
        open={variantModalOpen}
        onClose={closeVariantModal}
        title={editingVariant ? "Edit Variant" : "Add Variant"}
        footer={
          <>
            <Button variant="secondary" onClick={closeVariantModal}>
              Cancel
            </Button>
            <Button
              onClick={handleVariantSubmit}
              loading={createProduct.isPending || updateProduct.isPending}
            >
              {editingVariant ? "Save Changes" : "Create Variant"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Variant Name <span className="text-danger">*</span>
            </label>
            <input
              value={variantForm.variantName}
              onChange={(e) => setVariantForm((f) => ({ ...f, variantName: e.target.value }))}
              placeholder='e.g. "Chocolate", "Large", "500ml"'
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">SKU</label>
            <div className="flex gap-2">
              <input
                ref={variantSkuRef}
                value={variantForm.sku}
                onChange={(e) => setVariantForm((f) => ({ ...f, sku: e.target.value }))}
                placeholder="Optional SKU or barcode"
                className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <BarcodeScannerButton
                onScan={(code) => setVariantForm((f) => ({ ...f, sku: code }))}
                inputRef={variantSkuRef}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">Pricing Tiers</label>
            <div className="grid grid-cols-5 gap-2">
              {(
                [
                  ["T1 (List)", "price"],
                  ["T2", "priceTier2"],
                  ["T3", "priceTier3"],
                  ["T4", "priceTier4"],
                  ["T5", "priceTier5"],
                ] as [string, keyof typeof variantForm][]
              ).map(([label, field], idx) => {
                const val = parseFloat(variantForm[field]) || 0;
                const prevField =
                  idx > 0
                    ? (["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const)[
                        idx - 1
                      ]
                    : null;
                const prevVal = prevField ? parseFloat(variantForm[prevField]) || 0 : Infinity;
                const warn = idx > 0 && val > prevVal;
                return (
                  <div key={field}>
                    <p className="mb-1 text-xs text-navy/70">{label}</p>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={variantForm[field]}
                      onChange={(e) => setVariantForm((f) => ({ ...f, [field]: e.target.value }))}
                      className={cn(
                        "w-full rounded border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
                        warn ? "border-warning text-warning" : "border-surface-border",
                      )}
                    />
                    {warn && (
                      <p className="mt-0.5 text-xs text-warning">
                        Higher than {label.split(" ")[0] === "T2" ? "T1" : `T${idx}`}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-navy/70">
              Higher tiers (volume) are typically equal to or lower than Tier 1.
            </p>
          </div>

          {!editingVariant && (
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/70">Unit</label>
              <input
                value={variantForm.unit}
                onChange={(e) => setVariantForm((f) => ({ ...f, unit: e.target.value }))}
                placeholder={product.unit}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          )}
        </div>
      </Modal>

      {/* ── Make Variant Of Modal ── */}
      <Modal
        open={makeVariantOpen}
        onClose={() => setMakeVariantOpen(false)}
        title="Make variant of…"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMakeVariantOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleMakeVariantSubmit} loading={updateProduct.isPending}>
              Link as variant
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Link <span className="font-medium text-navy">{product.name}</span> as a variant (flavor,
            size, etc.) of another product. The product name will be updated to match the parent.
          </p>

          {/* Parent selection */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Parent product <span className="text-danger">*</span>
            </label>
            <div className="flex gap-2">
              <select
                value={makeVariantParentId}
                onChange={(e) => setMakeVariantParentId(e.target.value)}
                className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">— Select a product —</option>
                {allProducts
                  .filter((p: any) => !p.parentProductId && p.id !== params.id)
                  .map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <BarcodeScannerButton
                onScan={handleMakeVariantScan}
                title="Scan another product's barcode to auto-select it as the parent"
              />
            </div>
            {makeVariantScanLoading && (
              <p className="mt-1 text-xs text-navy/70">Looking up product…</p>
            )}
          </div>

          {/* Flavor / variety name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Flavor / variety <span className="text-danger">*</span>
            </label>
            <input
              value={makeVariantName}
              onChange={(e) => setMakeVariantName(e.target.value)}
              placeholder='e.g. "Chocolate", "Large", "500ml"'
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* If parent has no variantName yet, ask for one */}
          {makeVariantParentId &&
            (() => {
              const parent = allProducts.find((p: any) => p.id === makeVariantParentId) as any;
              if (!parent || parent.variantName) return null;
              return (
                <div>
                  <label className="mb-1 block text-xs font-medium text-navy/70">
                    Variant name for <span className="text-navy">{parent.name}</span>
                    <span className="ml-1 text-navy/70">(optional)</span>
                  </label>
                  <input
                    value={makeVariantParentOwnName}
                    onChange={(e) => setMakeVariantParentOwnName(e.target.value)}
                    placeholder='e.g. "Original", "Regular", "Standard"'
                    className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="mt-1 text-xs text-navy/70">
                    Since {parent.name} doesn&apos;t have a variant name, you can assign one now so
                    it appears alongside its variants.
                  </p>
                </div>
              );
            })()}

          {/* Preview of composed name */}
          {makeVariantParentId &&
            makeVariantName.trim() &&
            (() => {
              const parent = allProducts.find((p: any) => p.id === makeVariantParentId) as any;
              return parent ? (
                <div className="rounded bg-surface-raised px-3 py-2 text-xs text-navy/70 space-y-0.5">
                  <p>
                    This product:{" "}
                    <span className="font-medium text-navy">
                      {parent.name} - {makeVariantName.trim()}
                    </span>
                  </p>
                  {makeVariantParentOwnName.trim() && !parent.variantName && (
                    <p>
                      {parent.name}:{" "}
                      <span className="font-medium text-navy">
                        {parent.name} - {makeVariantParentOwnName.trim()}
                      </span>
                    </p>
                  )}
                </div>
              ) : null;
            })()}
        </div>
      </Modal>

      {/* ── Link Existing Product as Variant Modal ── */}
      <Modal
        open={linkExistingOpen}
        onClose={() => setLinkExistingOpen(false)}
        title="Link existing product as variant"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLinkExistingOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleLinkExistingSubmit} loading={updateProduct.isPending}>
              Link as variant
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Pick an existing standalone product to adopt as a variant of{" "}
            <span className="font-medium text-navy">{product.name}</span>.
          </p>

          {/* Searchable product list */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Product <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              placeholder="Search by name or SKU…"
              value={linkExistingSearch}
              onChange={(e) => setLinkExistingSearch(e.target.value)}
              className="mb-2 w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <div className="max-h-40 overflow-y-auto rounded border border-surface-border">
              {filteredLinkCandidates.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-navy/70">
                  No matching standalone products.
                </p>
              ) : (
                filteredLinkCandidates.map((p: any) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setLinkExistingProductId(p.id)}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised transition-colors",
                      linkExistingProductId === p.id && "bg-brand-50 ring-1 ring-brand-300",
                    )}
                  >
                    <div>
                      <span className="font-medium text-navy">{p.name}</span>
                      {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
                    </div>
                    <span className="text-xs text-navy/70">
                      ${parseFloat(String(p.pricePerUnit)).toFixed(2)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Variant / flavor name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Flavor / variety <span className="text-danger">*</span>
            </label>
            <input
              value={linkExistingVariantName}
              onChange={(e) => setLinkExistingVariantName(e.target.value)}
              placeholder='e.g. "Chocolate", "Large", "500ml"'
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* If this (parent) product has no variantName yet, ask for one */}
          {!product.variantName && (
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/70">
                Variant name for <span className="text-navy">{product.name}</span>
                <span className="ml-1 text-navy/70">(optional)</span>
              </label>
              <input
                value={linkExistingParentVariantName}
                onChange={(e) => setLinkExistingParentVariantName(e.target.value)}
                placeholder='e.g. "Original", "Regular", "Standard"'
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="mt-1 text-xs text-navy/70">
                Assign a variant name to this product too, so both appear in the variants table with
                their own identifiers.
              </p>
            </div>
          )}

          {/* Name preview */}
          {linkExistingProductId && linkExistingVariantName.trim() && (
            <div className="rounded bg-surface-raised px-3 py-2 text-xs text-navy/70 space-y-0.5">
              <p>
                Selected product:{" "}
                <span className="font-medium text-navy">
                  {product.name} - {linkExistingVariantName.trim()}
                </span>
              </p>
              {linkExistingParentVariantName.trim() && !product.variantName && (
                <p>
                  This product:{" "}
                  <span className="font-medium text-navy">
                    {product.name} - {linkExistingParentVariantName.trim()}
                  </span>
                </p>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
