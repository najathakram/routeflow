/**
 * Test-only: the REAL RouteFlowGateway inside a real Nest app on a real Socket.IO server (Nest's
 * own IoAdapter — the namespace wiring production uses), reached by real socket.io-client
 * connections carrying real signed JWTs. The caller supplies the only stand-in, Prisma, which
 * should apply the `where` it is sent and throw on any filter shape it does not model (L-081).
 *
 * Same technique as routeflow.gateway.buyer-rooms.spec.ts (B104): every connection is awaited to
 * the end of `handleConnection`, so a socket cannot pass a negative check merely because its rooms
 * were not joined yet; and negative assertions are made by ordering, never by waiting — `flush`
 * sends a marker to each client's own socket-id room, and Socket.IO delivers a connection's
 * packets in order, so once the marker is back every earlier event that was going to arrive has.
 */
import { INestApplication } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { Test } from "@nestjs/testing";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { PrismaService } from "../../prisma/prisma.service";
import { RouteFlowGateway } from "../routeflow.gateway";

const SECRET = "live-gateway-harness-secret";
const MARKER = "test.marker";
const signer = new JwtService({ secret: SECRET });

export interface LiveClient {
  socket: ClientSocket;
  /** Every event this client received, in arrival order (markers excluded). */
  events: Array<{ event: string; payload: any }>;
}

export interface LiveGateway {
  gateway: RouteFlowGateway;
  connect(token: string): Promise<LiveClient>;
  /** Resolves once everything emitted before this call has reached each client. */
  flush(...clients: LiveClient[]): Promise<void>;
  /** The rooms the SERVER holds this client in, minus its own socket-id room. */
  serverRooms(client: LiveClient): Promise<string[]>;
  close(): Promise<void>;
}

/** A buyer access token as the server mints it: 15 minutes (JWT_EXPIRES_IN's default, #2142 R1). */
export const buyerToken = (sub: string, extra: Record<string, unknown> = {}) =>
  signer.sign(
    { sub, email: `${sub}@example.test`, name: sub, type: "BUYER", ...extra },
    { expiresIn: "15m" },
  );

export const staffToken = (sub: string, role: string, tenantId: string) =>
  signer.sign({
    sub,
    username: sub,
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId,
    tenantSlug: "acme",
  });

/** The names of the events a client received, in order. */
export const eventNames = (client: LiveClient) => client.events.map((e) => e.event);

export async function startLiveGateway(prisma: unknown): Promise<LiveGateway> {
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: SECRET })],
    providers: [RouteFlowGateway, { provide: PrismaService, useValue: prisma }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  app.useWebSocketAdapter(new IoAdapter(app));
  const gateway = app.get(RouteFlowGateway);
  const connectionSpy = jest.spyOn(gateway, "handleConnection");
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  const sockets: ClientSocket[] = [];
  let markerSeq = 0;

  async function connect(token: string): Promise<LiveClient> {
    const socket = io(url, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const events: LiveClient["events"] = [];
    socket.onAny((event: string, payload: unknown) => {
      if (event !== MARKER) events.push({ event, payload });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    await Promise.all(connectionSpy.mock.results.map((r) => r.value));
    return { socket, events };
  }

  async function flush(...clients: LiveClient[]): Promise<void> {
    await Promise.all(
      clients.map(({ socket }) => {
        const marker = `m-${++markerSeq}`;
        const arrived = new Promise<void>((resolve) => {
          const onMarker = (id: string) => {
            if (id !== marker) return;
            socket.off(MARKER, onMarker);
            resolve();
          };
          socket.on(MARKER, onMarker);
        });
        gateway.server.to(socket.id!).emit(MARKER, marker);
        return arrived;
      }),
    );
  }

  async function serverRooms(client: LiveClient): Promise<string[]> {
    const [remote] = await gateway.server.in(client.socket.id!).fetchSockets();
    return [...(remote?.rooms ?? [])].filter((r) => r !== client.socket.id).sort();
  }

  async function close(): Promise<void> {
    for (const s of sockets.splice(0)) s.disconnect();
    await app.close();
  }

  return { gateway, connect, flush, serverRooms, close };
}
