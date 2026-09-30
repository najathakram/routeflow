/**
 * `@LeaderCron` — `@Cron` with a cross-replica leader lock.
 *
 * WHY: `ScheduleModule` schedules per PROCESS, so every replica fires every job on every tick.
 * With two API instances that means two trial expiries, two cycle rolls, two generated invoice
 * runs — duplicated writes with no error anywhere. A `pg_try_advisory_lock` on the job's name
 * makes the database the single arbiter: the instance that wins the lock runs the tick, everyone
 * else returns immediately. The lock lives on the connection for the whole body and is released
 * when it finishes, so the next tick is a fresh election.
 *
 * WHY THE NAME IS A LITERAL: the name IS the lock key, and it must hash to the same value in
 * every process, so it can never be derived from anything process-local (a class name is fine
 * until a bundler mangles it). `<area>.<method>` is enforced by `NAME_RE` at class-definition
 * time — a typo is a startup crash, not a job that silently runs everywhere.
 *
 * WHY THE WRAPPER IS INSTALLED BEFORE `Cron` IS APPLIED: `@nestjs/schedule`'s `Cron` is
 * metadata-only (`SetMetadata` writes onto `descriptor.value`), and the explorer registers
 * `instance[methodName]` after reading that metadata off it. Replacing `descriptor.value` first
 * therefore puts the metadata on the WRAPPER and registers the wrapper; applying `Cron` first
 * would leave the metadata on the unwrapped original. `name` is passed through to `Cron` so the
 * scheduler keys the job by it (`SchedulerOrchestrator.addCron` falls back to a per-process
 * random UUID when it is absent), which also makes the job addressable in `SchedulerRegistry`.
 *
 * BEHAVIOUR CHANGE, DELIBERATE: an overlapping tick on the SAME instance (a job still running
 * when its next tick fires) is now skipped too, because it contends for the same lock. That is
 * the safer default for every job here — all 13 are idempotent sweeps, not accumulators.
 *
 * A skipped tick is never an error: `acquired: false` logs at debug, and a `LockUnavailableError`
 * (the lock pool could not hand out a connection) logs at warn and skips. Anything the BODY
 * throws propagates unchanged — the scheduler's own try/catch logs it, exactly as before.
 *
 * WHAT A SKIPPED TICK ACTUALLY COSTS — it is NOT uniformly "one interval". Eleven of the thirteen
 * jobs re-derive their work from state on every tick, so a lost one self-repairs on the next:
 * `billing-cron.rollCycles` (any subscription whose `periodEnd` has passed is still selected),
 * `commission-reconciliation.reconcileCommissions` (a 25 h look-back deliberately overlapping its
 * hourly cadence), `recurring-invoices.generateDueRecurringInvoices` (`nextRunAt` stays `lte now`
 * until an invoice is actually generated), `regulated-filing.autoPrepareClosedFilings` (a DAILY
 * tick targeting a monthly/quarterly/annual closed period, so many ticks cover each period), and
 * the due-date sweeps — `billing-cron.expireTrials`/`expireGrace`/`applyScheduledDowngrades`/
 * `applyScheduledCancellations`, `billing.suspendOverdueTenants`,
 * `authorization-expiry.runExpirySweep`, `orders.cronSweepPendingOrders`.
 *
 * TWO DO NOT self-repair. `tobacco-report.generateMonthlyReports` generates exactly `now − 1
 * month` and fires once a month, and `order-templates.generateDailyOrders` generates only TODAY's
 * weekday (its idempotency check is also scoped to today). A tick either loses is a missed MONTH
 * of regulatory reports / a missed DAY of template orders that no later tick reproduces — it
 * needs a manual re-run. FOLLOW-ON: give those two a catch-up window (generate every unreported
 * period / every un-generated day since the last run) instead of a single-period query, and the
 * asymmetry disappears.
 *
 * RESIDUAL, DELIBERATE: a tick whose body never settles pins the lock indefinitely, and every
 * replica then skips that job until the process ends. A hold cap is deliberately REJECTED —
 * releasing the lock cannot cancel the body that is still running, so a cap would license exactly
 * the thing this decorator prevents: two concurrent money ticks. The remedy is the job's own
 * timeouts, plus the TCP keepalive on the cron lock pool (`./db-locks.ts`, "WHY KEEPALIVE"),
 * which keeps a legitimately-held session from being silently reaped and handed to a rival.
 */

import { Logger } from "@nestjs/common";
import { Cron, type CronOptions } from "@nestjs/schedule";
import { LockUnavailableError, withAdvisoryLock, type LockResult } from "./db-locks";

/** Advisory-lock family for every scheduled job; see `db-locks.ts` for why families exist. */
export const CRON_LOCK_FAMILY = "cron";

const NAME_RE = /^[a-z0-9-]+\.[A-Za-z0-9]+$/;
const logger = new Logger("LeaderCron");

/**
 * `CronOptions` is `Base & ({timeZone} | {utcOffset})` — a deliberate XOR, because the library
 * warns that setting both does something undefined. A plain `Omit` resolves that union into one
 * flat object carrying BOTH keys, which then no longer satisfies `CronOptions` (and would let a
 * caller pass both). Distributing the omit over the union keeps the exclusivity intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type LeaderCronOptions = DistributiveOmit<CronOptions, "name">;

/**
 * Schedule `cronTime` so the tick runs on exactly one instance.
 *
 * @param cronTime cron expression (or a `CronExpression` constant) — unchanged from `@Cron`.
 * @param name stable `<area>.<method>` identifier; it is BOTH the advisory-lock key and the
 *   `SchedulerRegistry` key, so it must be unique across the app and identical in every process.
 */
export function LeaderCron(
  cronTime: string,
  name: string,
  options: LeaderCronOptions = {},
): MethodDecorator {
  // Thrown while the class is being defined, so a bad name cannot reach production as a job
  // that locks on `(cron, <typo>)` and therefore never contends with its real twin.
  if (!NAME_RE.test(name)) {
    throw new Error(`LeaderCron: invalid job name "${name}" (expected "<area>.<method>")`);
  }
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      // Declared `: Promise<unknown>` so the generic resolves to `unknown` — `Function.apply`
      // returns `any` under this tsconfig (`strictBindCallApply: false`), which would otherwise
      // leak straight out of the tick as an untyped value.
      const runTick = (): Promise<unknown> => original.apply(this, args) as Promise<unknown>;
      let result: LockResult<unknown>;
      try {
        result = await withAdvisoryLock(
          { family: CRON_LOCK_FAMILY, key: name, mode: "try" },
          runTick,
        );
      } catch (e) {
        // A cron must never take the process down because the lock pool was momentarily
        // exhausted. What the skip costs depends on the job — see the header's "WHAT A SKIPPED
        // TICK ACTUALLY COSTS"; for the two jobs that do not self-repair it is a missed period,
        // which is still preferable to crashing the process.
        if (e instanceof LockUnavailableError) {
          logger.warn(`cron ${name}: lock connection unavailable — tick skipped`);
          return undefined;
        }
        throw e;
      }
      if (!result.acquired) {
        logger.debug(`cron ${name}: another instance holds the lock — tick skipped`);
        return undefined;
      }
      return result.value;
    };
    Cron(cronTime, { ...options, name })(target, propertyKey, descriptor);
  };
}
