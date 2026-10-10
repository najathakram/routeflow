import type { INestApplication } from "@nestjs/common";

/**
 * #2267: bind a supertest-driven Nest app to 127.0.0.1 on an OS-chosen port, once, before any
 * request.
 *
 * Why not `app.init()` + `request(app.getHttpServer())`: supertest then calls `listen(0)` itself
 * for EVERY request. With no host that binds the IPv6 wildcard `[::]:X`, and supertest connects to
 * `127.0.0.1:X`. On macOS another process (a parallel jest worker's fake server bound to
 * 127.0.0.1) can hold the more specific `127.0.0.1:X` at the same moment. The connection then
 * reaches THAT server: "Parse Error: Expected HTTP/" or a socket hang-up, only under load, never
 * alone.
 *
 * Bound here, `127.0.0.1:X` is this app's own for the whole suite (a second IPv4 bind on it is
 * EADDRINUSE), and supertest reuses the listening server instead of re-listening per request.
 * `app.listen` runs `init()` when needed; `app.close()` in afterAll closes the listener.
 */
export async function listenOnLoopback(app: INestApplication): Promise<void> {
  await app.listen(0, "127.0.0.1");
}
