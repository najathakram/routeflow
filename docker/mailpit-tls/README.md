# Local mailpit TLS pair (THROWAWAY, generated per machine — do not reuse)

`cert.pem` / `key.pem` are generated per machine by `scripts/lib/mailpit-tls.mjs` (called from
`scripts/local-env.mjs`), never committed (the blanket `*.pem` ignore covers them), and regenerated
when missing, unparsable or expired. They let the compose `mailpit` service offer real STARTTLS so the SMTP
integration spec (`apps/api/src/email/email-smtp.smtp.spec.ts`) exercises the same
connect → STARTTLS → AUTH → send path production uses against Google Workspace.

- Self-signed, 10-year validity, CN `routeflow-local-mailpit`, SAN `localhost`, `mailpit`,
  `127.0.0.1`, `::1`. It protects nothing: the SMTP port is bound to localhost only and the
  credential is a local throwaway. Never put a real
  key here and never trust this cert anywhere else.
- Clients trust it via `NODE_EXTRA_CA_CERTS` (compose `api` service; `local-env.mjs --smtp-specs`
  for the host-side spec). Certificate verification is NOT disabled anywhere.
- Manual regenerate (rarely needed):

  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -keyout docker/mailpit-tls/key.pem \
    -out docker/mailpit-tls/cert.pem -days 3650 -subj "/CN=routeflow-local-mailpit" \
    -addext "subjectAltName=DNS:localhost,DNS:mailpit,IP:127.0.0.1,IP:::1"
  ```
