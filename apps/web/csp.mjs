// CSP construction for next.config.mjs's headers(), extracted so the policy
// can be unit-tested directly — next.config.mjs itself only loads under
// Next's own runtime, which pins NODE_ENV to "production" during `next build`
// (see the comment on `isDev` at the call site).

// apiConnectSources(apiUrl): the compiled Docker image bakes
// NEXT_PUBLIC_API_URL in at build time. When that origin is `http:` (e.g. the
// local Docker Compose stack's `http://localhost:3000`), connect-src's
// `https: wss:` blanket alone blocks every API call and the socket.io
// upgrade from a browser served over http — this returns the concrete
// http/ws origin pair to splice in. Anything else (a normal https prod API,
// or an unset/invalid value) returns "" and connect-src is unchanged.
export function apiConnectSources(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    return "";
  }
  if (url.protocol !== "http:") {
    return "";
  }
  const origin = url.origin;
  return ` ${origin} ${origin.replace(/^http:/, "ws:")}`;
}

// buildContentSecurityPolicy({ isDev, apiUrl }): the full CSP directive list
// next.config.mjs's headers() sends on every route. `isDev` only ever adds
// the `next dev` wildcard localhost sources (never present in a built
// image); `apiUrl` (NEXT_PUBLIC_API_URL) is what actually lets a built image
// reach a non-https API — see apiConnectSources above.
export function buildContentSecurityPolicy({ isDev, apiUrl }) {
  return [
    "default-src 'self'",
    // Google Maps: @vis.gl/react-google-maps injects the Maps JS API script
    // tag; without these two hosts EVERY dashboard map (trip builder, route
    // create/detail) loads a permanently blank <Map> — the CSP added in
    // 8aacd2d7 post-dated the Maps integration and silently broke them all.
    `script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    // Dev (`next dev`): the local API/socket run on plain http/ws
    // (localhost:3000), which `https: wss:` alone blocks — every API call
    // fails CSP. A built image (isDev always false, per the call-site
    // comment) gets the same relaxation only when NEXT_PUBLIC_API_URL itself
    // is an http: origin, via apiConnectSources; a normal https prod build
    // is byte-identical to before this file existed.
    `connect-src 'self' https: wss:${isDev ? " http://localhost:* ws://localhost:*" : ""}${apiConnectSources(apiUrl)}`,
    // PDF previews render in an <iframe> from a blob: URL (invoice scanning,
    // the invoice builder) or from a signed API/storage URL (customer
    // documents). Without an explicit frame-src these fall back to
    // default-src 'self' and render blank — images were unaffected because
    // img-src already allows blob:, which is why PNGs previewed but PDFs did
    // not. `data:` is deliberately excluded: data: URIs in frames are an XSS
    // vector, and nothing here needs them.
    "frame-src 'self' blob: https:",
    // Google's vector-map renderer (Advanced Markers use a mapId) can spin
    // up a blob: worker; without this it falls back to default-src 'self'
    // and marker pins never render even once the script loads.
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
