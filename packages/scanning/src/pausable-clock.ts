// SA-1067 C2: moved here from the counter strip so the order builder's camera uses the SAME clock (SA-1059).
/**
 * A clock that stops while scanning is blocked. The engine reads "absent" off the `now` it is given (a code unseen for 0.6 s
 * counts again), so with the camera off or frames dropped a code still held in view would look absent and recount on resume.
 * Time spent blocked is added to an offset and taken off `now()`, so a pause is no time at all to the engine, with two limits:
 *  - a block that came from dropped frames (the clerk typing elsewhere, a dialog) froze only up to the LAST frame dropped: the
 *    code was in view until then. What came after it, with no frame at all, is real time, so a code that was taken away for 5 s
 *    and brought back is a new scan;
 *  - a hard block (the camera is off, or a receipt is up) sends no frames, so nothing says the code left: it freezes right up
 *    to the first frame accepted afterwards (the camera takes a moment to deliver one once it is back on).
 * Either way the block ends only on an accepted frame, never on the camera coming back.
 */
export function createPausableClock(read: () => number = Date.now) {
  let offset = 0;
  let since: number | null = null;
  let lastDropped: number | null = null;
  let hard = false;
  return {
    now: () => (since === null ? read() - offset : since - offset),
    /** A hard block: no frames are coming (camera off, receipt up). Frozen until the first accepted frame. */
    block: () => {
      if (since === null) since = read();
      hard = true;
    },
    /** A frame arrived and was dropped: the code was in view at least until now. */
    drop: () => {
      const t = read();
      if (since === null) since = t;
      lastDropped = t;
    },
    /** An accepted frame: the block, if any, is over. */
    unblock: () => {
      if (since !== null) offset += (hard || lastDropped === null ? read() : lastDropped) - since;
      since = null;
      lastDropped = null;
      hard = false;
    },
  };
}

export type PausableClock = ReturnType<typeof createPausableClock>;
