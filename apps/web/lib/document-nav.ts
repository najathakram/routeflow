/**
 * A full document navigation (the auth providers live at the app root and read localStorage only on mount, so a fresh
 * session needs a hard load). Behind an object so a test can observe it: jsdom cannot intercept location.replace.
 */
export const documentNav = {
  replace(url: string): void {
    window.location.replace(url);
  },
};
