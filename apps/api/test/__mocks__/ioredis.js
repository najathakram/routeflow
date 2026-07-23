/**
 * Manual Jest mock for `ioredis` (wired via moduleNameMapper in the API jest
 * config). Unit specs must never open a real TCP socket: several services
 * (`GoogleOAuthService`, `RedisThrottlerStorage`) construct a live `new Redis(...)`
 * pointed at `redis://localhost:6379`, and when a spec exercised a code path that
 * issued a command (e.g. `google-oauth.service` `this.redis.set(state)`), ioredis
 * connected, failed (no Redis in CI/local test env), and scheduled reconnect
 * timers that lingered in a jest worker — intermittently hanging the whole suite
 * with "a worker process has failed to exit gracefully" (the reason the suite
 * needed `--forceExit`). No unit spec asserts real Redis behavior, and production
 * code is untouched; this replaces the client with an inert, socket-free stub.
 *
 * Covers both `import Redis from "ioredis"` (default) and `import { Redis } from "ioredis"`.
 */
class RedisMock {
  constructor() {
    this.status = "ready";
  }
  // Event emitter surface used by the services (they attach "error"/"connect").
  on() {
    return this;
  }
  once() {
    return this;
  }
  off() {
    return this;
  }
  emit() {
    return false;
  }
  // Lifecycle — resolve immediately, open nothing.
  connect() {
    return Promise.resolve();
  }
  disconnect() {
    return undefined;
  }
  quit() {
    return Promise.resolve("OK");
  }
  // Command surface used across the codebase — safe no-op defaults.
  get() {
    return Promise.resolve(null);
  }
  set() {
    return Promise.resolve("OK");
  }
  del() {
    return Promise.resolve(0);
  }
  incr() {
    return Promise.resolve(1);
  }
  expire() {
    return Promise.resolve(1);
  }
  ttl() {
    return Promise.resolve(-1);
  }
  pttl() {
    return Promise.resolve(-1);
  }
  eval() {
    return Promise.resolve([1, -1]);
  }
  ping() {
    return Promise.resolve("PONG");
  }
}

module.exports = RedisMock;
module.exports.Redis = RedisMock;
module.exports.default = RedisMock;
