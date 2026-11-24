import {
  ESTIMATE_ACTION_VALUES,
  ESTIMATE_MOVES as SHARED_MOVES,
  canMoveEstimate as sharedCanMove,
} from "@routeflow/types";
import { ESTIMATE_MOVES, canMoveEstimate } from "./estimate-moves";

// SA-1263 A1: the api cannot value-import @routeflow/types at runtime, so it mirrors the table. This pins the mirror
// equal to the shared one (the one web and mobile read), action by action and status by status.
describe("estimate-moves parity (api copy vs @routeflow/types)", () => {
  it("has the same actions and the same from-statuses for each", () => {
    expect(Object.keys(ESTIMATE_MOVES).sort()).toEqual([...ESTIMATE_ACTION_VALUES].sort());
    for (const action of ESTIMATE_ACTION_VALUES) {
      expect({ action, from: [...ESTIMATE_MOVES[action]] }).toEqual({
        action,
        from: [...SHARED_MOVES[action]],
      });
    }
  });

  it("answers every (status, action) the same", () => {
    const statuses = ["DRAFT", "SENT", "ACCEPTED", "DECLINED", "CONVERTED", "VOID", "NOPE"];
    for (const s of statuses) {
      for (const a of ESTIMATE_ACTION_VALUES) {
        expect({ s, a, ok: canMoveEstimate(s, a) }).toEqual({ s, a, ok: sharedCanMove(s, a) });
      }
    }
  });
});
