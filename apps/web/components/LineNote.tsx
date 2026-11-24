import * as React from "react";
import { splitLineNote } from "@/lib/line-note-list";

/**
 * A line's free-text note, read-only. A list-style note ("ACME MINT 20, ACME ICE 10") prints one
 * entry per line as a small list; any other note prints as today's single paragraph. The caller's
 * `className` carries its own colour and size.
 */
export function LineNote({ note, className = "" }: { note: string; className?: string }) {
  const parts = splitLineNote(note);
  if (!parts) {
    return <p className={`mt-0.5 whitespace-pre-line font-normal italic ${className}`}>{note}</p>;
  }
  return (
    <ul
      className={`mt-0.5 list-disc space-y-0 pl-3.5 font-normal not-italic leading-snug ${className}`}
    >
      {parts.map((part, i) => (
        <li key={i} className="break-words pl-0.5 marker:text-[0.7em]">
          {part}
        </li>
      ))}
    </ul>
  );
}
