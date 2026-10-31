/**
 * SA-1067 M3: the most one unit of a line may sell for. The server's `unitPrice` DTOs and the till's price dialog
 * (`OVER_LIMIT`) both read this, so a value the server would answer with a 400 is refused where it is typed. A million
 * dollars keeps the line math inside the Decimal(10,2) the schema reserves for totals.
 */
export const MAX_UNIT_PRICE = 1_000_000;
