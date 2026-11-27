# Wave 3 Docker proof item: raw page files through the BUILT image

Against the built web image (production build, `local:up`), request each of the ten pages
(home, pricing, product, landing, getting-started, does-and-doesnt, data-in-and-out, security,
company, contact) by these 6 spellings of `/site/<page>.html` (curl, no -L, then once with -L):

1. plain: `/site/<page>.html`
2. first letter percent-encoded: `/site/%70ricing.html`
3. every letter encoded: `/site/%70%72%69%63%69%6e%67.html`
4. double encoded: `/site/%2570ricing.html`
5. upper case with trailing dot: `/SITE/PRICING.HTML.`
6. encoded extension dot plus query: `/site/pricing%2ehtml?x=1`

Assert: no response body (with or without -L) contains `{{brand:`; variants 1-6 answer 307 to the clean
address (query kept); a malformed one (`/site/%70ricing.html%`) answers 400; `/site/css/site.css`
still answers 200. Also request the same variants over the dev server once, because `public/` lookup
order differs between `next dev` and the standalone server.

## Added by the lead (2026-11-14)
Against the BUILT image (port 3001), exact checks:
- `curl -si :3001/site/%70ricing.html` -> 307, `location` ends `/pricing`
- `curl -si :3001/site/%2570ricing.html` -> 307 to `/pricing`
- `curl -si :3001/site/pric%ing.html` -> 400
- no response body contains `{{brand:` for any of the above, with or without `-L`

## Added by the coordinator (wave 1)
- Exactly one `id="brand-tokens"` style per page: fetch /, /pricing, /privacy, /login, /signup, /buyer/login and a 404 from the built web image and count (must be 1 each; BrandTokens is mounted in SiteFrame only).
- Root layout favicon: `curl -sI :3001/favicon.ico` answers 200 `image/x-icon` after the move to `public/` (lane B1), and `/login` head lists the front-door icon first.
- Built API image boots (`brand.json` reachable through `require.resolve("@routeflow/types/package.json")`, `apps/api/Dockerfile:66-69`): send one platform email to a log transport and check the logo `src` host and size attributes.
