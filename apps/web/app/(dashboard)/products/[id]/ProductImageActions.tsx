"use client";

import * as React from "react";
import { Trash2, Upload } from "lucide-react";

/**
 * The image gallery's action row (select-mode toggle, bulk delete, upload) and its hidden file
 * input, moved out of page.tsx as-is for the size ratchet. The page still owns every piece of
 * state and every handler; this only renders them.
 */
export function ProductImageActions({
  selectMode,
  setSelectMode,
  selectedImages,
  setSelectedImages,
  deleteSelected,
  deletePending,
  uploadPending,
  cropping,
  fileInputRef,
  handleUpload,
}: {
  selectMode: boolean;
  setSelectMode: (on: boolean) => void;
  selectedImages: Set<number>;
  setSelectedImages: (next: Set<number>) => void;
  deleteSelected: () => void;
  deletePending: boolean;
  uploadPending: boolean;
  /** A crop is open (`!!cropState` on the page). */
  cropping: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleUpload: (files: FileList | null) => void;
}) {
  return (
    <>
      {/* Action row: select-mode toggle + bulk delete + upload */}
      <div className="flex items-center gap-2">
        {selectMode ? (
          <>
            <button
              onClick={deleteSelected}
              disabled={selectedImages.size === 0 || deletePending}
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
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadPending || cropping}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-white py-1.5 text-xs text-navy/70 hover:border-brand-500/50 hover:text-brand-500 transition-colors disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          {uploadPending ? "Uploading…" : "Upload images"}
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
    </>
  );
}
