// W-1188: the counter's typed date ("yesterday", "fri", "11/02") and the plain labels the chip and the picker show.
// Pure: the tenant's today is passed in (never the browser's clock), days are YYYY-MM-DD strings, US month-first by default.
import { addDays, daysBetween, isRealDay } from "@routeflow/pricing";

export type DayOrder = "MDY" | "DMY";
export interface NaturalDateOptions {
  /** SEAM: a non-US tenant is a setting later, not a rewrite. */
  dayOrder?: DayOrder;
  /** The counter allows future days; the office order does not. */
  allowFuture?: boolean;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const pad = (n: number) => String(n).padStart(2, "0");
const weekdayOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const weekdayIndex = (w: string) => {
  const i = WEEKDAYS.indexOf(w.slice(0, 3));
  return i >= 0 && (w.length === 3 || w === WEEKDAY_NAMES[i]) ? i : -1;
};
// As strict as weekdayIndex: the 3-letter abbreviation, "sept", or the whole name. "junk" and "marked" are not months.
const monthIndex = (w: string) => {
  if (w === "sept") return 8;
  const abbr = MONTHS.indexOf(w);
  return abbr >= 0 ? abbr : MONTH_WORDS.indexOf(w);
};

/** The occurrence of month/day nearest `today` (a tie goes to the past), or null when the date is not real. */
function nearest(month: number, dom: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  let best: string | null = null;
  let bestGap = Infinity;
  for (const y of [year - 1, year, year + 1]) {
    const day = `${y}-${pad(month)}-${pad(dom)}`;
    if (!isRealDay(day)) continue;
    const gap = Math.abs(daysBetween(today, day));
    if (gap < bestGap || (gap === bestGap && day < (best as string))) {
      best = day;
      bestGap = gap;
    }
  }
  return best;
}

/** A two-digit year ("24") is read as 20xx, exactly like "2024": the picker's range check then answers both the same way. */
function withYear(y: number, month: number, dom: number, twoDigit: boolean): string | null {
  const full = twoDigit ? 2000 + y : y;
  const day = `${full}-${pad(month)}-${pad(dom)}`;
  return isRealDay(day) ? day : null;
}

/** The typed text as a day, or null when it is not one. Never throws. */
export function parseNaturalDate(
  input: string,
  today: string,
  opts: NaturalDateOptions = {},
): string | null {
  const order = opts.dayOrder ?? "MDY";
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  const result = (day: string | null) => {
    if (!day) return null;
    if (opts.allowFuture === false && day > today) return null;
    return day;
  };

  if (text === "today" || text === "tdy") return today;
  if (text === "yesterday" || text === "yday" || text === "y") return addDays(today, -1);
  if (text === "tomorrow" || text === "tmrw") return result(addDays(today, 1));

  const next = /^next ([a-z]+)$/.exec(text);
  if (next) {
    const w = weekdayIndex(next[1]);
    if (w < 0) return null;
    const ahead = ((w - weekdayOf(today) + 6) % 7) + 1; // 1..7: the coming one, never today
    return result(addDays(today, ahead));
  }
  const wd = weekdayIndex(text);
  if (wd >= 0) return addDays(today, -((weekdayOf(today) - wd + 7) % 7));

  const off = /^([+-])(\d{1,4})$/.exec(text);
  if (off) return result(addDays(today, (off[1] === "-" ? -1 : 1) * Number(off[2])));
  const ago = /^(\d{1,4}) ?d(?:ays?)? ago$/.exec(text);
  if (ago) return addDays(today, -Number(ago[1]));

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return result(withYear(Number(iso[1]), Number(iso[2]), Number(iso[3]), false));

  const num = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(text);
  if (num) {
    const [a, b] = [Number(num[1]), Number(num[2])];
    const [month, dom] = order === "MDY" ? [a, b] : [b, a];
    if (month < 1 || month > 12) return null;
    return result(
      num[3]
        ? withYear(Number(num[3]), month, dom, num[3].length === 2)
        : nearest(month, dom, today),
    );
  }

  const named = /^([a-z]+) (\d{1,2})$/.exec(text) ?? /^(\d{1,2}) ([a-z]+)$/.exec(text);
  if (named) {
    const [mw, dw] = /^\d/.test(text) ? [named[2], named[1]] : [named[1], named[2]];
    const month = monthIndex(mw);
    if (month < 0) return null;
    return result(nearest(month + 1, Number(dw), today));
  }
  return null;
}

const MONTH_LABEL = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Fri, Nov 6", and the year when it is not the tenant's current year: "Tue, Dec 30, 2025". */
export function dayLabel(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const base = `${WEEKDAY_LABEL[weekdayOf(day)]}, ${MONTH_LABEL[m - 1]} ${d}`;
  return y === Number(today.slice(0, 4)) ? base : `${base}, ${y}`;
}

/** "Fri" - the short tag on a Today's sales row. */
export const weekdayShort = (day: string): string => WEEKDAY_LABEL[weekdayOf(day)];

/** "3 days ago", "yesterday", "in 7 days", "tomorrow". */
export function relativeDaysLabel(day: string, today: string): string {
  const n = daysBetween(today, day);
  if (n === 0) return "today";
  if (n === -1) return "yesterday";
  if (n === 1) return "tomorrow";
  return n < 0 ? `${-n} days ago` : `in ${n} days`;
}

const MONTH_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Nov 9, 2024" - a day with its year, for a message that names a limit. */
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTH_LABEL[m - 1]} ${d}, ${y}`;
}

/** "October 2026" from "2026-10" (a period key) or a full day. */
export function monthYearLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MONTH_FULL[m - 1]} ${y}` : "That month";
}

/** "Friday, November 6" - the long form screen readers get. */
export function fullDayName(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${WEEKDAY_NAMES[weekdayOf(day)].replace(/^./, (c) => c.toUpperCase())}, ${MONTH_FULL[m - 1]} ${d}`;
}
