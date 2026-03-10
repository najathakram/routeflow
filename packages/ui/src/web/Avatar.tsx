"use client";

import * as React from "react";
import { cn } from "./utils";

const SIZE_CLASSES = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
} as const;

export type AvatarSize = keyof typeof SIZE_CLASSES;

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string;
  alt?: string;
  name?: string;
  size?: AvatarSize;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, src, alt, name, size = "md", ...props }, ref) => {
    const [imgError, setImgError] = React.useState(false);
    React.useEffect(() => { setImgError(false); }, [src]);
    const showImage = src && !imgError;

    return (
      <div
        ref={ref}
        className={cn(
          "relative inline-flex items-center justify-center overflow-hidden rounded-full bg-brand-100 font-medium text-brand-700 flex-shrink-0",
          SIZE_CLASSES[size],
          className,
        )}
        aria-label={alt ?? name}
        {...props}
      >
        {showImage ? (
          <img
            src={src}
            alt={alt ?? name ?? "Avatar"}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : name ? (
          getInitials(name)
        ) : (
          <svg
            className="h-3/5 w-3/5 text-brand-500"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
          </svg>
        )}
      </div>
    );
  },
);

Avatar.displayName = "Avatar";
