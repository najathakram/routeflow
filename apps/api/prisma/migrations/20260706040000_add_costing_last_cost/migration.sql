-- LAST_COST costing method (pos-cost-roles-spec §1).
-- Purely additive: appends one value to the CostingMethod enum. Touches no
-- existing table, column, or row; existing products keep their current method.
ALTER TYPE "CostingMethod" ADD VALUE 'LAST_COST';
