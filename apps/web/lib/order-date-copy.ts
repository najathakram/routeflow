// W-1188: the words of the date chip and its picker, one entry per noun. The same control dates an order (the till, the
// regular order) and a sale (the New sale invoice form): each entry is a whole string, never a noun glued into a sentence,
// so a language or a third noun later is one more entry. `order-date-copy.inventory.test.ts` fails when the chip or picker
// spell "Order date" outside this map.
export type OrderDateNoun = "order" | "sale";

export interface OrderDateCopy {
  /** the field's name */
  label: string;
  /** the chip's accessible name while the day is Today */
  todayName: string;
  /** the chip's accessible name while the business's day is unknown (checking or could not check) */
  unknownName: (dayName: string, failed: boolean) => string;
  /** the x beside a dated chip */
  clearName: string;
  /** the dialog's title */
  dialogTitle: string;
  /** a typed day the form does not take */
  outsideRange: string;
}

export const ORDER_DATE_COPY: Record<OrderDateNoun, OrderDateCopy> = {
  order: {
    label: "Order date",
    todayName: "Order date: today. Change",
    unknownName: (dayName, failed) =>
      `Order date ${dayName}, ${failed ? "could not check the business's day" : "checking the business's day"}. Clear`,
    clearName: "Clear the order date, back to today",
    dialogTitle: "Order date",
    outsideRange: "That day is outside the dates this till takes.",
  },
  sale: {
    label: "Sale date",
    todayName: "Sale date: today. Change",
    unknownName: (dayName, failed) =>
      `Sale date ${dayName}, ${failed ? "could not check the business's day" : "checking the business's day"}. Clear`,
    clearName: "Clear the sale date, back to today",
    dialogTitle: "Sale date",
    outsideRange: "That day is outside the dates a sale can have.",
  },
};
