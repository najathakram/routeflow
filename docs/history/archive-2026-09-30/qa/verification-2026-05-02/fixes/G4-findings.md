# G4

## Items addressed

| NEW       | Sev | Status                   | Files                                                                           | Commit             | Test added                                                 |
| --------- | --- | ------------------------ | ------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| NEW-vop-3 | P2  | Fixed                    | `apps/mobile/lib/api/admin.ts`, `apps/mobile/app/(operator)/settings/index.tsx` | fix: NEW-vop-2/3/4 | Yes — `apps/api/src/users/users.service.spec.ts` (6 tests) |
| NEW-vop-2 | P2  | Script written (not run) | `apps/api/scripts/purge-xss-customer-names.js`                                  | fix: NEW-vop-2/3/4 | n/a (one-shot script)                                      |
| NEW-vop-4 | P3  | Fixed                    | `apps/mobile/Dockerfile`                                                        | fix: NEW-vop-2/3/4 | n/a (infrastructure)                                       |

## Notes / blockers

### NEW-vop-3 — Users tab showing "No users found."

Root cause: `useAdminUsers()` in `apps/mobile/lib/api/admin.ts` declared its
return type as `AppUser[]` and passed `r.data` straight through. The `/users`
endpoint returns `{ data: AppUser[], meta: {...} }` (same paginated envelope as
every other list endpoint). So `r.data` was the paginated _object_, not the
array. `Array.isArray(users)` in `UsersTab` returned `false` → `list` was empty
every time.

Fix:

- Changed `useAdminUsers` return type to `{ data: AppUser[]; meta: PaginationMeta }`.
- Added `limit: 100` default so all users are fetched in one page (matches the
  operator web portal behaviour for the settings user-list).
- In `UsersTab`, changed `const list = Array.isArray(users) ? users : []` to
  `const list: AppUser[] = Array.isArray(usersPage?.data) ? usersPage.data : []`.

### NEW-vop-2 — XSS-polluted customer names

Script `purge-xss-customer-names.js` targets tenant
`8ee7bbf5-991b-41b1-adcb-4a6c20981401` only. It matches rows where
`businessName` contains an HTML tag opener (`<\w+`) or the literal string `XSS`,
AND the customer has zero Orders and zero Invoices. Uses a parameterised DELETE
and is idempotent. Follows the same `pg` Client + Railway TCP proxy pattern as
`purge-live-svg-xss.js`. **Not run** — awaiting operator sign-off.

### NEW-vop-4 — Service worker / stale bundle cache

No `sw.js` is registered in the mobile app. The app is served as a static SPA
via nginx (see `apps/mobile/Dockerfile`). The Expo export already produces
content-hashed JS/CSS filenames, so the only file that does not rotate on
redeploy is `index.html`.

Fix: added a dedicated `location = /index.html` block in the nginx config
template that sets `Cache-Control: no-cache, no-store, must-revalidate` plus
`Pragma: no-cache` and `Expires: 0`. The hashed JS/CSS bundles are left to cache
normally via ETags.

## User-visible proof of fix

- **NEW-vop-3**: Settings → Users tab will now list all tenant users instead of
  the empty "No users found." state. Activate/Deactivate toggles remain
  functional.
- **NEW-vop-2**: After running the script (operator decision), the customer list
  will no longer show rows with names like
  `<img src=x onerror=alert("XSS-W18")>`, `XSS Test`, `test`.
- **NEW-vop-4**: After the next Railway redeploy, browsers that previously cached
  the old `index.html` will receive the new one immediately (no-cache forces
  revalidation), so the fresh JS bundle is loaded.
