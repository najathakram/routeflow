/**
 * A menu entry that opens a dialog runs a tick later: while the menu is still closing, its focus trap and
 * the new dialog's fight over focus (an endless focus ping-pong in jsdom, a flicker in a browser).
 * A menu with an exit animation needs `onCloseAutoFocus` instead, as `ProductHeaderControls` does: a tick is shorter than
 * the animation.
 */
export const afterMenuCloses = (fn: () => void) => () => {
  setTimeout(fn, 0);
};
