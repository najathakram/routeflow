/**
 * The username a restored customer gets back (REG-B159): an explicit override wins; otherwise the delete's
 * "~removed~<id8>" tombstone suffix is stripped (ONE suffix only, a pre-fix row carries none). Moved verbatim out
 * of `CustomersService.restoreCustomer` to keep that file under its size ratchet. Pure.
 */
export function restoredUsernameFor(
  id: string,
  currentUsername: string,
  overrideUsername?: string,
): string {
  const tombstoneSuffix = `~removed~${id.slice(0, 8)}`;
  return (
    overrideUsername ||
    (currentUsername.endsWith(tombstoneSuffix)
      ? currentUsername.slice(0, -tombstoneSuffix.length)
      : currentUsername)
  );
}
