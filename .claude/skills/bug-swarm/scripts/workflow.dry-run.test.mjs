import { test } from "node:test";
import { runAll } from "./workflow.dry-run.mjs";

test("workflow.js satisfies the /bug-swarm v1 contract (stubbed agents)", async () => {
  await runAll();
});
