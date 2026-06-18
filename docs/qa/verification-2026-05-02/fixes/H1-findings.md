# H1

## Plan (5 bullets)

1. **Read hooks + layouts + auth stores** to understand the full data-flow from login → Zustand store hydration → `useEffect` dep change → `io()` call.
2. **Add diagnostic `[socket]` console logs** at every decision point in both `useSocket` and `useBuyerSocket`, gated on `EXPO_PUBLIC_DEBUG_SOCKET !== 'false'`.
3. **Fix SSR / pre-render crash path** — add a `globalThis.window == null || globalThis.localStorage == null` guard so the hooks skip silently when the Expo web pre-render server has no DOM globals (previously they would reach `localStorage.getItem(...)` and throw, silently aborting `connect()` before `io()` was ever called).
4. **Fix transport order** — change from `["websocket", "polling"]` to `["polling", "websocket"]` so the Socket.IO handshake always starts with HTTP long-polling (which Railway's proxy is confirmed to handle); the client upgrades to WebSocket after the handshake succeeds.
5. **Extend tests** to cover: polling-first transport assertion, SSR-guard (no window, no localStorage), user/buyer null→set re-hydration sequence.

## Root cause(s) found

**Primary — SSR / pre-render silent abort:**
Both hooks called `localStorage.getItem(...)` inside the async `connect()` callback without first checking whether `localStorage` exists. In Expo web builds Railway serves a pre-rendered HTML shell; during that pass the component tree is rendered in a JavaScript context where `window` and `localStorage` are `undefined`. `connect()` threw a `ReferenceError: localStorage is not defined`, which was swallowed by the `void connect()` call, so `io()` never fired. After the hydration the component was already rendered and the `useEffect` had run-and-errored; since `user` / `buyer` didn't change again after hydration, the effect never re-ran to retry.

**Secondary — WebSocket-first transport blocks Railway proxy:**
`transports: ["websocket", "polling"]` asks socket.io-client to start with a raw WebSocket upgrade. Railway's proxy layer requires the Socket.IO polling handshake first before it will forward WebSocket frames. Starting with `"websocket"` causes the connection attempt to stall/fail before ever falling back. Correct order is `["polling", "websocket"]`.

## Files changed

| File                                          | Change                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/hooks/useSocket.ts`              | Added `[socket]` debug logging; added `globalThis.window/localStorage` SSR guard; changed transport order to `["polling", "websocket"]`       |
| `apps/mobile/hooks/useBuyerSocket.ts`         | Same as above for buyer surface                                                                                                               |
| `apps/mobile/__tests__/socket-wiring.test.ts` | Added 8 new test cases: SSR-guard (no window / no localStorage), transport-order assertion, user hydration null→set, buyer hydration null→set |

No layout files needed changes — `useSocket()` and `useBuyerSocket()` are already correctly mounted at `(operator)/_layout.tsx`, `(driver)/_layout.tsx`, `(customer)/_layout.tsx`.

## Tests added

New test cases in `apps/mobile/__tests__/socket-wiring.test.ts` (total 16 tests, up from 8):

- `useSocket — operator: uses polling-first transport order for Railway proxy compatibility`
- `useSocket — SSR guard: does NOT call io() when window is undefined`
- `useSocket — SSR guard: does NOT call io() when localStorage is undefined`
- `useSocket — SSR guard: does NOT throw when localStorage is undefined`
- `useSocket — user hydration: connects when effect re-runs after user transitions from null to set`
- `useBuyerSocket: uses polling-first transport order`
- `useBuyerSocket: does NOT call io() in SSR context (no window)`
- `useBuyerSocket: connects when buyer transitions from null to set`

All 16 tests pass. `tsc --noEmit` clean.

## Verification expectation (what should appear in Chrome console after deploy)

After deploying and logging in as operator / driver / buyer, open Chrome DevTools → Console. Within ~2 seconds of reaching the home screen you should see:

```
[socket] hook mount, role= OPERATOR user= <id>
[socket] storage read key=rf:op:accessToken token=[present]
[socket] calling io(https://routeflowapi-production.up.railway.app)
[socket] connected <socket-id>
```

For driver role:

```
[socket] hook mount, role= DRIVER user= <id>
[socket] storage read key=rf:driver:accessToken token=[present]
[socket] calling io(https://routeflowapi-production.up.railway.app)
[socket] connected <socket-id>
```

For buyer role:

```
[socket:buyer] hook mount, buyer= <id>
[socket:buyer] storage read key=rf:buyer:accessToken token=[present]
[socket:buyer] calling io(https://routeflowapi-production.up.railway.app)
[socket:buyer] connected <socket-id>
```

Network tab should show a successful `GET /socket.io/?EIO=4&transport=polling` (200) followed shortly by a WebSocket upgrade (`101 Switching Protocols`).

To disable diagnostic logs after confirming: set `EXPO_PUBLIC_DEBUG_SOCKET=false` in the Railway mobile service env vars and redeploy.
