// Preload fixture for visibility-watchdog-script.spec.ts's REG-WATCHDOG-SLOWBOOT repro.
// Loaded via NODE_OPTIONS="--require <this file>" to simulate a child process whose Node
// bootstrap takes ~1.5s before it reaches the target script's own code — deterministic and
// host-speed-independent (unlike waiting on real OS/host jitter).
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
