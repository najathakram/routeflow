// W-720: the DB lane's setupFilesAfterEnv. withAdvisoryLock (src/common/db-locks.ts) opens one lazy
// pg.Pool per lock family on first use and keeps it for the process, so its idle clients hold
// jest open after the last test until pg's 10 s idle timeout ("Jest did not exit"). A spec could
// end them itself (`_resetLockPoolForTests` in an afterAll), but every new spec can forget that
// opt-in. This hook runs in EVERY DB spec's own module registry, so it ends the pools that spec's
// code opened. Ending an empty map is a no-op. PrismaService's own pool is ended by its
// $disconnect (prisma.service.ts); both have to close for jest to exit at once.
const { _resetLockPoolForTests } = require("../src/common/db-locks");

afterAll(async () => {
  await _resetLockPoolForTests();
});
