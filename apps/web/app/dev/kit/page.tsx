import { notFound } from "next/navigation";
import { KitGallery } from "./kit-gallery";

/**
 * DEV-ONLY kit gallery (#2331): the web primitives in the same states as the native gallery
 * (`apps/mobile/app/(auth)/dev-kit.tsx`), captured at 390 for the side-by-side proof. It returns
 * 404 in a production build.
 */
export default function DevKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <KitGallery />;
}
