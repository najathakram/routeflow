/**
 * The one sentence a refused Claude key save shows. It is the web's own closed copy, never the server's text (B986):
 * the API's 400 for a key of the wrong shape means exactly this, so the status picks the words. Any other failure shows
 * the toast title alone.
 */
export const CLAUDE_KEY_SHAPE_COPY = "That doesn't look like a Claude API key.";

export function saveKeyErrorDescription(err: any): string | undefined {
  return err?.response?.status === 400 ? CLAUDE_KEY_SHAPE_COPY : undefined;
}
