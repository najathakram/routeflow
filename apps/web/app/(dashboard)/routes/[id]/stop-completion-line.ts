/**
 * The line under a stop ("Completed 8:15 AM"). It follows the stop's STATUS, the same field the run's
 * "n of m done" counts use, so a stop never reads Completed while the header says it is not (UX guide B22).
 */
export function stopCompletionLine(stop: {
  status: string;
  completedAt?: string | null;
}): string | null {
  if (!stop.completedAt) return null;
  const word =
    stop.status === "COMPLETED" ? "Completed" : stop.status === "SKIPPED" ? "Skipped" : null;
  if (!word) return null;
  const at = new Date(stop.completedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${word} ${at}`;
}
