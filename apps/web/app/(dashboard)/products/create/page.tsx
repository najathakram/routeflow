/**
 * RF-203: /products/create was a 404 (no page file). Product creation is a
 * modal on the list page (?action=new). This redirect ensures the URL works
 * and the create modal opens immediately — no 15-second spinner.
 *
 * This file renders no form fields, so the pack-size prompt (in-app pack-size
 * plan, WP2) is NOT here on the create side — it sits next to the
 * name/unit/unitsPerBox fields in `@/components/ProductCreateModal`, the
 * actual create form opened by `?action=new` above.
 */
import { redirect } from "next/navigation";

export default function ProductCreatePage() {
  redirect("/products?action=new");
}
