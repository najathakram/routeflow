import { createPausableClock } from "./pausable-clock";

// SA-1059 (moved with the clock): the clock's arithmetic.
describe("createPausableClock", () => {
  const make = () => {
    let t = 1000;
    const clock = createPausableClock(() => t);
    return { clock, at: (n: number) => void (t = n), tick: (n: number) => void (t += n) };
  };

  it("runs with real time when nothing is blocked", () => {
    const { clock, tick } = make();
    const a = clock.now();
    tick(500);
    expect(clock.now() - a).toBe(500);
  });

  it("a hard block (camera off) freezes everything up to the first accepted frame", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.block();
    tick(3000);
    expect(clock.now() - a).toBe(0); // frozen while blocked
    tick(1500); // the camera is back on but has not delivered a frame
    clock.unblock(); // the first accepted frame
    expect(clock.now() - a).toBe(0);
    tick(100);
    expect(clock.now() - a).toBe(100);
  });

  it("a block of dropped frames freezes only up to the last frame dropped", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.drop();
    tick(2000);
    clock.drop(); // still in view 2 s later
    tick(5000); // then nothing in front of the camera for 5 s
    clock.unblock();
    expect(clock.now() - a).toBe(5000);
  });

  it("a hard block inside a block of dropped frames still freezes right up to the accepted frame", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.drop();
    tick(1000);
    clock.block();
    tick(4000);
    clock.unblock();
    expect(clock.now() - a).toBe(0);
  });

  it("a later block starts clean (nothing is carried from an earlier one)", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.block();
    tick(1000);
    clock.unblock();
    tick(300);
    clock.drop();
    tick(2000);
    clock.unblock(); // the last drop was the first: 0 ms frozen, 2000 ms real
    expect(clock.now() - a).toBe(2300);
  });
});
