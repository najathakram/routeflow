/** "1 variant" / "2 variants": count plus the singular noun, pluralised unless the count is 1. */
export function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
