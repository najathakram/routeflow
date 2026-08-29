import { redirect } from "next/navigation";

// Finance → "Expenses" and Warehouse → "Bills & Purchasing" used to be two nav
// entries for the same hub. "Bills & Purchasing" (/vendor-bills) is the one
// home now — this page is kept as a redirect so bookmarks, the command
// palette, and deep links to /finance/expenses keep working, tab included.
// Expense creation lives at /finance/expenses/new and is untouched by this stub.
export default function LegacyExpensesHubRedirect({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      query.append(key, v);
    }
  }
  const qs = query.toString();
  redirect(qs ? `/vendor-bills?${qs}` : "/vendor-bills");
}
