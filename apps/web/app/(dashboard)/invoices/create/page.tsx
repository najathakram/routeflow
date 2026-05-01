/**
 * RF-203: /invoices/create was a 404 (no page file). Invoice creation uses
 * the new invoice form at /invoices/new. This redirect ensures the URL works
 * and the create form renders immediately — no 15-second spinner.
 */
import { redirect } from "next/navigation";

export default function InvoiceCreatePage() {
  redirect("/invoices/new");
}
