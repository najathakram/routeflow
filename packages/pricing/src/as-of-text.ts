/**
 * SA-1209 D3: the ONE "as of" text for a document: date, time and zone, in the tenant's zone ("Nov 21, 2026, 4:46 PM CST").
 * The account block's heading and the PDF's "Generated" stamp both print it. The zone is never left out, and the runtime's
 * short name is used as is (a zone with no abbreviation prints "GMT+5:30"). Pure: the instant is an argument.
 */
export function asOfText(at: Date | string, timeZone: string): string {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}
