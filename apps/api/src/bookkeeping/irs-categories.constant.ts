export interface IrsCategorySeed {
  code: string;
  name: string;
}

export const IRS_SYSTEM_CATEGORIES: IrsCategorySeed[] = [
  { code: "ADVERTISING", name: "Advertising" },
  { code: "CAR_AND_TRUCK", name: "Car and Truck" },
  { code: "COMMISSIONS_AND_FEES", name: "Commissions and Fees" },
  { code: "CONTRACT_LABOR", name: "Contract Labor" },
  { code: "DEPRECIATION", name: "Depreciation" },
  { code: "EMPLOYEE_BENEFITS", name: "Employee Benefits" },
  { code: "INSURANCE", name: "Insurance" },
  { code: "INTEREST", name: "Interest" },
  { code: "LEGAL_AND_PROFESSIONAL", name: "Legal and Professional" },
  { code: "OFFICE_EXPENSE", name: "Office Expense" },
  { code: "PENSION_AND_PROFIT_SHARING", name: "Pension and Profit-sharing" },
  { code: "RENT_OR_LEASE", name: "Rent or Lease" },
  { code: "REPAIRS_AND_MAINTENANCE", name: "Repairs and Maintenance" },
  { code: "SUPPLIES", name: "Supplies" },
  { code: "TAXES_AND_LICENSES", name: "Taxes and Licenses" },
  { code: "TRAVEL", name: "Travel" },
  { code: "MEALS", name: "Meals (50%)" },
  { code: "UTILITIES", name: "Utilities" },
  { code: "WAGES", name: "Wages" },
  { code: "OTHER_EXPENSES", name: "Other Expenses" },
];
