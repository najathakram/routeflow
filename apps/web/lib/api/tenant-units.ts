// RED stub: the real client lands with the implementation commit.
export interface TenantUnitDto {
  id: string;
  name: string;
  archivedAt: string | null;
  productCount: number;
}
export interface TenantUnitUpdateResult {
  unit: TenantUnitDto;
  productsUpdated: number;
}

export function normalizeUnitName(_raw: string): string {
  throw new Error("not implemented");
}
export function checkUnitName(_raw: string, _units: TenantUnitDto[]): string | null {
  throw new Error("not implemented");
}
export function unitErrorMessage(_err: unknown, _name: string): string {
  throw new Error("not implemented");
}
export function useTenantUnits(): never {
  throw new Error("not implemented");
}
export function useCreateTenantUnit(): never {
  throw new Error("not implemented");
}
export function useUpdateTenantUnit(): never {
  throw new Error("not implemented");
}
