// The ONE rule for "who is working here": the lane, the member, and the name events are written
// under. The rf CLI and the prompt / SessionStart hook both call it; a pin in members-fix.test.mjs
// fails if a second copy of the actor rule appears anywhere else.
//
// The member is a LABEL, not a login: the team shares one GitHub account, and `rf whoami --member`
// (or RF_MEMBER) is whatever this computer says. memberMachineWarning makes a mismatch visible.
import { basename } from "node:path";
import { findMember, laneId, memberId, opsHome } from "./config.mjs";
import { laneForCwd } from "./lanes-local.mjs";

/** The member this computer works as (rf whoami --member / RF_MEMBER), when the config knows it. */
export function currentMember(config, env = process.env) {
  return config ? findMember(config, memberId(env)) : null;
}

/**
 * No --lane: RF_LANE, else the lane recorded for this directory (rf whoami --lane), else the
 * member's first lane, else null.
 */
export function defaultLane(config, env = process.env, cwd = process.cwd()) {
  return (
    laneId(undefined, config, env) ??
    laneForCwd(cwd, env, { config, home: opsHome(env) }) ??
    currentMember(config, env)?.lanes[0] ??
    null
  );
}

/**
 * The name events are written under: RF_ACTOR, else the member, else the lane, else
 * machine:folder (80 characters at most).
 */
export function actorFor({ env = process.env, machine, config, cwd = process.cwd() }, lane) {
  const member = currentMember(config, env)?.id ?? null;
  return (env.RF_ACTOR || member || lane || `${machine}:${basename(cwd)}`).slice(0, 80);
}

/**
 * Who reads and writes here: `{ lane, actor, member }`. `lane` undefined means "the default lane"
 * (pass null for none).
 */
export function whoIsHere({ env = process.env, machine, config, cwd = process.cwd(), lane }) {
  const l = lane === undefined ? defaultLane(config, env, cwd) : lane;
  return {
    lane: l ?? null,
    actor: actorFor({ env, machine, config, cwd }, l),
    member: currentMember(config, env)?.id ?? null,
  };
}

/**
 * A warning when the member's `machine` in the config is not this machine, else null. The member
 * name is only a label (one shared GitHub account), so a mismatch is worth seeing every time.
 */
export function memberMachineWarning(config, env, machine) {
  const m = currentMember(config, env);
  if (!m || !m.machine || m.machine === machine) return null;
  return `warning: member ${m.id} is listed on machine ${m.machine}, but this is ${machine}. The member name is a label, not a login: check rf whoami --member.`;
}
