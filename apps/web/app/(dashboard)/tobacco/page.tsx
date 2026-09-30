"use client";

/**
 * /tobacco → the Regulated Items hub. The standalone tobacco surface retired
 * into the compliance pack (2026-08-24 consolidation); deep links in the wild
 * must not 404. Client-side because the target section id is tenant-specific.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useTrackedCategories } from "@/lib/api/tracked-categories";

export default function TobaccoRedirect() {
  const router = useRouter();
  const { data: categories, isSuccess, isError } = useTrackedCategories();
  React.useEffect(() => {
    if (isError) {
      router.replace("/compliance");
      return;
    }
    if (!isSuccess) return;
    const tobacco = categories?.find((c) => c.isTobaccoCategory);
    router.replace(tobacco ? `/compliance/${tobacco.id}` : "/compliance");
  }, [isSuccess, isError, categories, router]);
  return (
    <div className="flex items-center justify-center p-12">
      <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
    </div>
  );
}
