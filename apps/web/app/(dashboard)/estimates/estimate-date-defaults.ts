// The operator's own local calendar date, not the UTC one — `.toISOString()`
// would show tomorrow's date once local time crosses midnight UTC (e.g. any
// evening in a timezone west of UTC). This is the input's default only; the
// value itself stays a plain calendar-date string, storage unaffected.
export function defaultIssueDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 30 local-calendar days after the (already-local) issue date — takes the
// computed issueDate rather than re-deriving "today" independently, so the
// two defaults can never drift apart at a midnight boundary. The multi-arg
// Date constructor is always local (unlike parsing an ISO string), and
// correctly rolls month/year over for a day value past the month's end.
export function defaultExpiryDate(fromIssueDate: string) {
  const [y, m, day] = fromIssueDate.split("-").map(Number);
  const d = new Date(y, m - 1, day + 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
