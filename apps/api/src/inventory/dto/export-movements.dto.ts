import { ListMovementsDto } from "./list-movements.dto";

/**
 * `GET /inventory/movements/export.csv` query: every list filter (paging fields are accepted and
 * ignored — the export is never paged).
 */
export class ExportMovementsDto extends ListMovementsDto {}
