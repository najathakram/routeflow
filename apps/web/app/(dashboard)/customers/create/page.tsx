/**
 * RF-203: /customers/create was a 404 (no page file). Customer creation is a
 * modal on the list page (?action=new). This redirect ensures the URL works
 * and the create modal opens immediately — no 15-second spinner.
 */
import { redirect } from "next/navigation";

export default function CustomerCreatePage() {
  redirect("/customers?action=new");
}
