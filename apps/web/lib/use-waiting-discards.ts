import * as React from "react";

/**
 * Discards that wait for their Undo toast to close (parked sales and order drafts share this). Each Discard gets its OWN
 * token, so a toast that closes late can only act on the discard it was made for: Discard A, Undo, Discard A again, and the
 * first toast closing never touches the second discard. A row stays hidden while any token for it waits, and after its delete
 * has left, until `failed` brings it back.
 */
export function useWaitingDiscards() {
  const waiting = React.useRef(new Map<string, string>()); // token -> row id
  const sent = React.useRef(new Set<string>()); // ids whose delete has left
  const counter = React.useRef(0);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  const sync = () => setHidden(new Set([...waiting.current.values(), ...sent.current]));

  return {
    hidden,
    /** A row was discarded: hide it and return the token that discard alone can undo or commit. */
    begin(id: string): string {
      counter.current += 1;
      const token = `${id}#${counter.current}`;
      waiting.current.set(token, id);
      sync();
      return token;
    },
    /** Take back that discard. False when it was already undone or sent (a stale call does nothing). */
    undo(token: string): boolean {
      if (!waiting.current.delete(token)) return false;
      sync();
      return true;
    },
    /** Its toast closed: the row id to delete now, or null when that discard was undone or already sent. */
    commit(token: string): string | null {
      const id = waiting.current.get(token);
      if (id === undefined) return null;
      waiting.current.delete(token);
      sent.current.add(id);
      sync();
      return id;
    },
    /** The delete failed: the row comes back. */
    failed(id: string) {
      sent.current.delete(id);
      sync();
    },
  };
}
