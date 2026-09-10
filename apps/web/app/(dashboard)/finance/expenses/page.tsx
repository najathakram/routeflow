import { redirect } from "next/navigation";

// Finance → "Expenses" and Warehouse → "Bills & Purchasing" used to be two nav
// entries for the same hub. "Bills & Purchasing" (/vendor-bills) is the one
// home now — this page is kept as a redirect so bookmarks, the command
// palette, and deep links to /finance/expenses keep working, tab included.
// Expense creation lives at /finance/expenses/new and is untouched by this stub.
export default async function LegacyExpensesHubRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      query.append(key, v);
    }
  }
  const qs = query.toString();
  redirect(qs ? `/vendor-bills?${qs}` : "/vendor-bills");
}
