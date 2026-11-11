"use client";

import * as React from "react";
import type { FeatureChangeAction, FeatureChangeInput } from "@routeflow/types";

/** What is staged on the Features tab: keyed by feature, in the order the admin staged them. Nothing is written until the review sheet saves. */
export interface FeatureStage {
  /** The hash of what the changes were made against; sent back on save (read when the first change is staged). */
  baseHash: string | null;
  changes: FeatureChangeInput[];
}

export const EMPTY_STAGE: FeatureStage = { baseHash: null, changes: [] };

/** Stage one change. Staging a key again replaces its earlier change; the order of first staging is kept. */
export function stageChange(stage: FeatureStage, change: FeatureChangeInput): FeatureStage {
  const at = stage.changes.findIndex((c) => c.key === change.key);
  const changes =
    at === -1 ? [...stage.changes, change] : stage.changes.map((c, i) => (i === at ? change : c));
  return { ...stage, changes };
}

/** Take one key's staged change back out; the last one out also forgets the hash, so the next stage re-reads it. */
export function unstageChange(stage: FeatureStage, key: string): FeatureStage {
  const changes = stage.changes.filter((c) => c.key !== key);
  return changes.length === 0 ? EMPTY_STAGE : { ...stage, changes };
}

export function stagedAction(stage: FeatureStage, key: string): FeatureChangeAction | null {
  return stage.changes.find((c) => c.key === key)?.action ?? null;
}

/** "1 change" / "3 changes": the one count the bar and the save button share. */
export function changeCountLabel(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

export interface FeatureStageApi {
  stage: FeatureStage;
  count: number;
  actionOf: (key: string) => FeatureChangeAction | null;
  stageOne: (change: FeatureChangeInput, baseHash: string) => void;
  unstageOne: (key: string) => void;
  discard: () => void;
}

export function useFeatureStage(): FeatureStageApi {
  const [stage, setStage] = React.useState<FeatureStage>(EMPTY_STAGE);
  const stageOne = React.useCallback((change: FeatureChangeInput, baseHash: string) => {
    // The hash is the one read before the FIRST staged change; later changes keep it.
    setStage((s) => stageChange(s.baseHash ? s : { ...s, baseHash }, change));
  }, []);
  const unstageOne = React.useCallback((key: string) => setStage((s) => unstageChange(s, key)), []);
  const discard = React.useCallback(() => setStage(EMPTY_STAGE), []);
  const actionOf = React.useCallback((key: string) => stagedAction(stage, key), [stage]);
  return { stage, count: stage.changes.length, actionOf, stageOne, unstageOne, discard };
}
