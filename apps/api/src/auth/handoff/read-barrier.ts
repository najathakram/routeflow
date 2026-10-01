/**
 * Test helper (#2653 single-use proof). Wraps a Prisma-like `authHandoffCode` delegate so every
 * `findFirst` performs its REAL read and then waits at a barrier until `parties` reads have
 * completed; only then do they all continue. Two exchanges therefore both SEE the row before
 * either one deletes it, the interleaving that lets a missing `count === 1` check hand out two
 * sessions. Without this, two "concurrent" calls often serialise on one connection and a
 * count-less consume still looks correct.
 */
type Delegate = {
  findFirst: (args: never) => Promise<unknown>;
  deleteMany: (args: never) => Promise<{ count: number }>;
  create: (args: never) => Promise<unknown>;
};

export function withReadBarrier<T extends Delegate>(real: T, parties: number): T {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    ...real,
    findFirst: async (args: never) => {
      const row = await real.findFirst(args);
      arrived += 1;
      if (arrived >= parties) release();
      await gate;
      return row;
    },
    deleteMany: (args: never) => real.deleteMany(args),
    create: (args: never) => real.create(args),
  } as T;
}
