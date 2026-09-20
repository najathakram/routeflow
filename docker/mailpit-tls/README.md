# Local mailpit TLS pair (THROWAWAY — do not reuse)

`cert.pem` / `key.pem` let the compose `mailpit` service offer real STARTTLS so the SMTP
integration spec (`apps/api/src/email/email-smtp.smtp.spec.ts`) exercises the same
connect → STARTTLS → AUTH → send path production uses against Google Workspace.

- Self-signed, 100-year validity, CN `routeflow-local-mailpit`, SAN `localhost`, `mailpit`,
  `127.0.0.1`, `::1`. It protects nothing: the SMTP port is bound to localhost only and the
  credential is a local throwaway. The private key being public is the point — never put a real
  key here and never trust this cert anywhere else.
- Clients trust it via `NODE_EXTRA_CA_CERTS` (compose `api` service; `local-env.mjs --smtp-specs`
  for the host-side spec). Certificate verification is NOT disabled anywhere.
- Regenerate (rarely needed):

  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -keyout docker/mailpit-tls/key.pem \
    -out docker/mailpit-tls/cert.pem -days 36500 -subj "/CN=routeflow-local-mailpit" \
    -addext "subjectAltName=DNS:localhost,DNS:mailpit,IP:127.0.0.1,IP:::1"
  ```
