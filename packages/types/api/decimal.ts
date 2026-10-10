/**
 * A Prisma `Decimal` column as a client reads it. It is a STRING on the wire today (Prisma's
 * `Decimal.toJSON`, and the API has no serializer), so consumers coerce with `Number()`. It
 * collapses to `number` once the API Decimal serializer lands (#2705). One alias, so that
 * change is a single edit — never write `string | number` for a money column (SA-562a).
 */
export type DecimalWire = number;
