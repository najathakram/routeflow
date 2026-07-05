import * as React from "react";
import { cn } from "./utils";

export interface SkeletonProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Shape: a text line (default), a block, or a circle (avatars/icons). */
  shape?: "line" | "block" | "circle";
  /** Width — number (px) or any CSS length. Defaults to 100%. */
  width?: number | string;
  /** Height — number (px) or any CSS length. Defaults to 12px (line). */
  height?: number | string;
}

/**
 * Ledger shimmer skeleton — baked into every list/detail while data loads.
 * Uses the `.skeleton` utility (globals.css), which respects reduced-motion.
 */
export const Skeleton = React.forwardRef<HTMLSpanElement, SkeletonProps>(
  ({ className, shape = "line", width, height, style, ...props }, ref) => {
    const h = height ?? (shape === "line" ? 12 : undefined);
    return (
      <span
        ref={ref}
        aria-hidden="true"
        className={cn(
          "skeleton block",
          shape === "circle" && "rounded-full",
          shape === "block" && "rounded-ctl",
          className,
        )}
        style={{
          width: typeof width === "number" ? `${width}px` : width,
          height: typeof h === "number" ? `${h}px` : h,
          ...style,
        }}
        {...props}
      />
    );
  },
);

Skeleton.displayName = "Skeleton";

/** Convenience: N skeleton table rows with the given column widths. */
export function SkeletonRows({
  rows = 5,
  columns,
}: {
  rows?: number;
  columns: (number | string)[];
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {columns.map((w, c) => (
            <td key={c} className="px-3 py-3">
              <Skeleton width={w} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
