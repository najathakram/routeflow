export function normalizeItemName(raw: string): string {
  return raw;
}

export function itemSourceKey(raw: string): string {
  return raw.split(":").pop() ?? raw;
}
