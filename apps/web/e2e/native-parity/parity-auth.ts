/** #2338: where the parity buyers' storage states live (gitignored; local test fixtures only). */
import path from "path";

export const PARITY_AUTH_DIR = path.join(__dirname, ".auth");

export const parityStateFile = (state: "loaded" | "empty") =>
  path.join(PARITY_AUTH_DIR, `buyer-${state}.json`);
