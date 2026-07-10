-- P5-04: PROMO price type — a line priced by an active buyer promotion (net
-- unitPrice + originalPrice strikethrough, discount:0). Purely additive: appends
-- one value to the PriceType enum. Touches no existing table, column, or row;
-- existing lines keep their current price type.
-- Safe under PostgreSQL's in-transaction ADD VALUE rule (prod is PG16).
ALTER TYPE "PriceType" ADD VALUE 'PROMO';
