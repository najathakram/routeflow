# RouteFlow Security Testing & Remediation Program

**Status:** adopted 2026-09-11 · **Owner:** platform · **Review:** quarterly

This is the standing security program and its research basis — the framework/tool landscape
that justifies the tiers below, not a findings report. Finding-level detail (repro notes,
severity rationale) lives in the gitignored root `SECURITY_AUDIT.md`, which is never committed
because the repo goes public during CI windows. Current remediation status per finding lives in
[`docs/audit/security-findings-index.md`](../audit/security-findings-index.md); this document is
the program those statuses feed into and get re-verified against.

**Disclosure discipline:** everything below is status and one-line description only. No exploit
steps, no request/response examples, no token or secret strings, and no live client identifiers
— tenant slugs, business names, or UUIDs are never used; illustrative examples use `acme`-style
placeholders.

## 1. Why this program exists

RouteFlow is a multi-tenant SaaS handling delivery, invoicing, and customer data for real
businesses. The realistic threat model is an attacker targeting the codebase (a public repo
during CI windows, a dependency supply chain, or a leaked secret), the running API (broken
authorization, injection, resource exhaustion), or tenant/customer data extraction — either
server-side (cross-tenant reads, IDOR) or client-side (tokens or PII sitting somewhere a browser
script or a stolen device can reach).

The program exists because the last comprehensive look was a single static audit run in
2026-06, producing 40 findings (1 Critical, 15 High, 7 Medium, 16 Low, 1 Info). The
Critical and High findings were fixed across two waves — PRs #84–#90 and a further wave in
PR #247 — but the audit itself was never repeated, and nothing continuous replaced it: no
recurring SAST, no container or secrets scanning, no DAST, and no dependency-reachability
triage. The findings index drifted out of date, with most Low-severity items sitting at
UNREVIEWED since 2026-08-28 — not confirmed fixed, not confirmed open, just untouched.

A source re-verification on 2026-09-11 (this program's first deliverable) closed part of that
gap: of the 12 findings marked UNREVIEWED or OPEN at the Low tier and the four still-OPEN
Medium items, 9 of the 12 UNREVIEWED lows were already fixed in source (never marked as such —
the audit report simply predated the fix), 3 are PARTIAL (a real but incomplete mitigation),
and 4 remain genuinely OPEN. Those results are recorded in the refreshed findings index.

The goal of this program is to turn that one-off audit into a continuous, tiered practice —
so the next gap is measured in weeks, not fifteen months — while keeping the effort
proportionate: a low-effort continuous gate that runs on every PR, a mid-effort periodic pass
tied to risk (auth/tenancy/money changes and major releases), and a high-effort episodic pass
(external pentest, red-team-style cross-tenant testing) tied to major changes and a yearly
cadence.

## 2. Frameworks, mapped to a low / mid / high ladder

RouteFlow's tiers below map directly onto established assurance ladders rather than inventing a
bespoke one:

- **OWASP ASVS 5.0** is the ladder itself: Level 1 is 70 requirements, fully automatable and the
  floor for this program's "low" tier; Level 2 is 183 requirements (cumulative) and is the
  appropriate bar for most applications handling sensitive data, matching the "mid" tier; Level 3
  adds 92 more requirements for high-assurance software and anchors the "high" tier.
  ([softwaremill.com](https://softwaremill.com/whats-new-in-asvs-5-0/),
  [cybersigmacs.com](https://cybersigmacs.com/knowledge-center/owasp-asvs/))
- **OWASP Top 10 (2025 draft)** reorders the risk landscape: Broken Access Control moves to #1,
  Security Misconfiguration rises from #5 to #2, and two categories are new — A03 Software Supply
  Chain Failures and A10 Mishandling of Exceptional Conditions — while SSRF is folded into A01
  rather than standing alone. This directly motivates the supply-chain (SCA/secrets/SBOM) and
  access-control emphasis in the tool landscape and tiers below.
  ([orca.security](https://orca.security/resources/blog/owasp-top-10-2025-key-changes/),
  [about.gitlab.com](https://about.gitlab.com/blog/2025-owasp-top-10-whats-changed-and-why-it-matters/))
- **OWASP API Security Top 10 (2023)** is the direct threat model for a tenant-scoped NestJS API:
  its first five categories are all authorization failures — Broken Object Level Authorization,
  Broken Authentication, Broken Object Property Level Authorization, Unrestricted Resource
  Consumption, and Broken Function Level Authorization — which is exactly the class of bug this
  audit's Critical/High findings (cross-tenant IDOR, BOLA/BFLA) came from.
  ([owasp.org](https://owasp.org/API-Security/editions/2023/en/0x00-toc/))
- **OWASP WSTG v4.2** is the manual test playbook for the mid/high tiers — the checklist a human
  reviewer or pentester works from beyond what automated scanners cover.
  ([owasp.org](https://owasp.org/www-project-web-security-testing-guide/))
- **OWASP MASVS / MASTG / MASWE** are the mobile equivalents, scoped to the Expo app across
  STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, and RESILIENCE — the categories the mid-tier mobile
  pass (Plane task 9) works through. ([mas.owasp.org/MASVS](https://mas.owasp.org/MASVS/),
  [mas.owasp.org/MASTG](https://mas.owasp.org/MASTG/))
- **OWASP SAMM v2** measures organizational maturity rather than any single application, and is
  the reference point for judging whether this program itself is maturing over time.
  ([owaspsamm.org](https://owaspsamm.org/model/))
- **NIST SSDF (SP 800-218)** organizes secure development into four practice groups (Prepare,
  Protect, Produce, Respond) and is increasingly what enterprise customers ask vendors to attest
  to — relevant if RouteFlow ever needs to answer a security questionnaire.
  ([csrc.nist.gov](https://csrc.nist.gov/projects/ssdf))
- **CWE Top 25 (2025)** ranks Cross-Site Scripting #1, SQL Injection #2, and CSRF #3 among the
  most dangerous software weaknesses — used here to tune SAST rule severity rather than treat
  every finding as equally urgent.
  ([cisa.gov](https://www.cisa.gov/news-events/alerts/2025/12/11/2025-cwe-top-25-most-dangerous-software-weaknesses))
- **CVSS 4.0** scores roughly 27% more findings as "Critical" than 3.1 would for the same
  underlying bugs, which means SLA bands (Section 5) must be re-baselined on 4.0 and never
  compared against a 3.1-era threshold. ([mend.io](https://www.mend.io/blog/cvss-3-1-vs-cvss-4-0-a-look-at-the-data/))
- **PTES** (seven phases: pre-engagement, intelligence gathering, threat modeling, vulnerability
  analysis, exploitation, post-exploitation, reporting) and **OSSTMM** structure the high-tier
  external pentest engagement's scope and deliverables.
  ([ibm.com](https://www.ibm.com/think/insights/pen-testing-methodology))

## 3. Tool landscape (Node/TypeScript, 2026)

| Category | Best-in-class | OSS/pricing note | Source |
| --- | --- | --- | --- |
| SAST | CodeQL, Semgrep, SonarQube Community, Snyk Code | CodeQL is free on public repos (GHAS ≈ $30/committer/mo for private repos); Semgrep's OSS engine is free with a free tier for teams ≤ 10 contributors; SonarQube Community is free self-hosted; Snyk Code has a free tier around 200 tests/mo | [safeguard.sh](https://safeguard.sh/resources/blog/best-sast-tools-2026), [konvu.com](https://konvu.com/compare/semgrep-vs-codeql) |
| SCA | `npm audit` → Dependabot/Renovate → Socket / Snyk Open Source → OSV-Scanner | `npm audit` is free but noisy and has no reachability analysis; Dependabot/Renovate are free; Socket and Snyk Open Source add behavioral, install-time malware detection; OSV-Scanner (Google) is OSS | [pkgpulse.com/npm-audit](https://www.pkgpulse.com/guides/why-npm-audit-is-broken), [pkgpulse.com/supply-chain](https://www.pkgpulse.com/guides/npm-supply-chain-security-guide-2026) |
| Secrets | gitleaks + TruffleHog + GitHub push protection | All three OSS/free — gitleaks for pre-commit, TruffleHog for liveness verification, GitHub push protection free on public repos (part of GHAS for private); layering all three catches more than any one alone | [dev.to](https://dev.to/chintanshah35/trufflehog-vs-gitleaks-vs-github-secret-scanning-why-most-ci-scanners-fail-2026-1372) |
| DAST | OWASP ZAP, Nuclei, Burp Suite | ZAP is OSS with an Automation Framework supporting authenticated scans; Nuclei is OSS, template-driven; Burp Suite Enterprise is commercial (~$10-40k/yr) | [guptadeepak.com](https://guptadeepak.com/tools/top-5-dast-tools-2026/) |
| Container/IaC | Trivy, Grype+Syft, Docker Scout, Hadolint | Trivy is OSS with the broadest coverage; Grype+Syft OSS; Docker Scout has a free tier; Hadolint (Dockerfile linting) is OSS | [aikido.dev](https://www.aikido.dev/blog/top-container-scanning-tools), [lucaberton.com](https://lucaberton.com/blog/trivy-vs-grype-2026/) |
| SBOM | Syft → CycloneDX/SPDX | Generate with Syft, emit CycloneDX or SPDX; the EU Cyber Resilience Act introduces reporting duties from September 2026 and requires a full SBOM by December 2027 | [appsecsanta.com](https://appsecsanta.com/sca-tools/sbom-tools-comparison), [github.com/anchore/syft](https://github.com/anchore/syft) |
| Headers/runtime | helmet (in use), securityheaders.com, Mozilla Observatory | helmet already in use; securityheaders.com's scanner is live and free (its paid API retired April 2026); Mozilla Observatory was archived in 2025 — reference only, not actionable | [dev.to/guardr](https://dev.to/guardr/securityheaderscom-api-is-gone-heres-the-migration-4461) |
| Fuzzing | ZAP fuzzer / ffuf; `fast-check` | ZAP's fuzzer or ffuf for endpoint fuzzing; `fast-check` for property-based tests, specifically valuable for money-math invariants | — |
| License | FOSSA, ScanCode | FOSSA is commercial; ScanCode is OSS | — |

## 4. The RouteFlow program: three tiers

### Low / ASVS L1 (continuous)

**Standard:** SAST, SCA, and secrets scanning on every PR and pre-commit; automated patch PRs;
a container scan per built image; nothing merges with an unaddressed Critical or High finding.

**Already in place ✓:** global `ValidationPipe` with `whitelist`/`forbidNonWhitelisted`;
`helmet()`; fail-closed `assertSecrets` covering the JWT, refresh, and storage-signing secrets;
a CORS allow-list; a Redis throttler that fails closed plus an env-tunable login throttle;
upload guards backed by `*.security.spec.ts`; `withAdvisoryLock` for customer-level order
merges; an `npm audit` critical gate with an expiring allowlist
(`security/audit-allowlist.json`); weekly grouped Dependabot; Squawk's destructive-migration
lint; the schema-drift gate; an addon-gate registry conformance spec; tenant-isolation specs;
and both the API and web Docker images running as a non-root `node` user.

**Planned → Plane tasks:** CodeQL (task 1), Trivy (task 2), gitleaks (task 3), SBOM generation
(task 4), a `SECURITY.md` disclosure policy (task 5), formalizing review tooling (task 6), a
non-root mobile image runner (task 11), and a standing RSC CVE patch-level check (OPS item).

### Mid / ASVS L2 (periodic)

**Standard:** a STRIDE pass for any feature touching auth, tenancy, or money; manual review of
authorization/tenancy/money code paths; authenticated DAST; reachability-based dependency
triage (does the vulnerable code path actually execute in this codebase); a full ASVS L2
checklist pass ahead of each major release.

**Already in place ✓:** dev-pipeline's Opus security lens, which runs automatically on
HIGH-risk files; `/security-review`, available on every diff on demand.

**Planned → Plane tasks:** an authenticated ZAP lane (task 7), an executable authz matrix spec
(task 8), and a MASVS pass over the mobile app (task 9).

### High / ASVS L3 (episodic)

**Standard:** an external pentest or red-team engagement yearly and after any major
authentication or tenancy change; a deliberate cross-tenant IDOR attempt against every
tenant-scoped resource type; business-logic abuse testing (promotion stacking, order-merge
races against the advisory-lock design); a scoped bug bounty restricted to approved test
tenants only.

**Planned → Plane task:** an ASVS L2 checklist pass plus pentest scoping (task 10) — an
owner-action item to procure an external engagement, following PTES phases and scoped strictly
to approved test tenants.

## 5. Fix practice and SLAs (adopted)

**Triage** weighs CVSS severity, exploitability (a public proof-of-concept or a listing in
CISA's Known Exploited Vulnerabilities catalog), and reachability (does RouteFlow's code
actually execute the vulnerable path). **Fix the shared primitive** — the guard, the
query-builder, the lock — rather than patching the one endpoint that got flagged; that is how
the F1-001/F1-002-style tenant-scope sweeps were done in #446. **Every finding gets a regression
spec** that fails against the pre-fix code and passes after. **Independent re-test** happens
before a finding is closed, not by the person who wrote the fix.

**SLA bands** (CVSS 4.0-baselined — never compare against a 3.1-era threshold, see Section 2):
Critical 24-72 hours, High 30 days, Medium 60-90 days, Low 90-180 days.
([secure.com](https://www.secure.com/blog/vulnerability-remediation-slas/))

**Secure-by-default checklist**, by app:

- **NestJS:** whitelist `ValidationPipe` ✓; `ThrottlerModule` plus a per-route `@Throttle` on
  authentication and expensive routes; `helmet` ✓; a guard on every tenant-scoped route; a
  short-lived access JWT with a rotating refresh token ✓; a CORS allow-list ✓.
- **Next.js:** never trust a client-settable header for authorization — the root cause of
  CVE-2025-29927 (Section 7); authorization belongs in the route handler or server component,
  never in middleware alone; CSP delivered via headers ✓; session cookies `httpOnly`, `secure`,
  and `sameSite` — the `tenant-slug` cookie is the one deliberate non-`httpOnly` exception,
  required so client-side code can read the active tenant.
- **Expo:** tokens held in SecureStore ✓; PKCE and a state parameter on every OAuth deep link;
  never establish a session from URL query parameters alone.

## 6. What Claude Code can already run

| Tool | How to run | Covers | Limits |
| --- | --- | --- | --- |
| `/security-review` | Free; diffs the working tree against `origin/HEAD` | Injection, authz/authn, crypto/secrets handling, XSS, data exposure | Report-only; reviews new code in the diff, not the whole codebase |
| `/code-review ultra [PR#]` | User-triggered, billed; deep multi-agent cloud review | Broad code quality and correctness | Not security-specific |
| dev-pipeline security lens | Automatic | Runs an Opus `edge-cases-and-security` lens on files the pipeline classifies HIGH-risk | Only fires inside a dev-pipeline run |
| `code-modernization:security-auditor` agent | Installed, needs enabling | OWASP/CWE checklist; runs `npm audit` | Not yet enabled in this repo |
| `security-guidance` plugin | Installed, enablement unconfirmed | Pattern-based plus LLM diff and commit-time cross-file review | Enablement needs to be confirmed |

None of the above performs DAST, fuzzing, or live exploitation — those remain the gap this
program's mid/high tiers (ZAP lane, pentest) are meant to close.

## 7. 2025-26 developments to track

- **CVE-2025-29927** — a Next.js middleware authorization bypass, patched at ≥14.2.25 and
  ≥15.2.3. RouteFlow is on 15.5.25 (#688), which is patched, but this is exactly the class of bug
  the "never trust a client-settable header for authorization" rule in Section 5 exists to
  prevent structurally, not just via a version bump.
  ([offsec.com](https://www.offsec.com/blog/cve-2025-29927/))
- **CVE-2025-55182 ("React2Shell")** — a pre-auth RCE in React Server Components, alongside
  CVE-2025-55183, CVE-2025-55184, and CVE-2026-23864. Patch level needs to be verified on every
  Next/React bump, not assumed from a version number alone — tracked as the standing OPS item in
  Section 8. ([react.dev](https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components),
  [microsoft.com](https://www.microsoft.com/en-us/security/blog/2025/12/15/defending-against-the-cve-2025-55182-react2shell-vulnerability-in-react-server-components/))
- **Shai-Hulud npm worms** — a self-propagating supply-chain compromise first seen September
  2025, a V2 wave in November 2025 affecting 700+ packages, and a "Mini" variant in May 2026
  spanning both npm and PyPI. This is the direct justification for behavioral SCA (Socket/Snyk
  Open Source) over signature-only auditing in Section 3.
  ([cisa.gov](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem),
  [microsoft.com](https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/))

## 8. Backlog catalogue (standing reference)

**Tracking rule:** every finding from a review, scanner, DAST, pentest, or audit is filed in
the bug registry with `--tag security`, PoC-free (no exploit detail or repro steps in the
filed row), with severity assigned by CVSS band — Critical ≥ 9.0, High 7.0–8.9,
Medium 4.0–6.9, Low < 4.0 — and a finding already fixed elsewhere is closed via
`bugs.mjs already-fixed <id> --pr <n> --why "<evidence>"` rather than left queued.

### Plane — ROAD epic "Security program — tooling & hardening (ASVS L1→L3)"

| # | Title | Labels | Priority | Effort | Acceptance |
| - | --- | --- | --- | --- | --- |
| 1 | CodeQL / SAST scanning in CI | security, infra | high | S | `codeql.yml` (javascript-typescript) on PR + weekly; owner decides GHAS-while-private vs public-window-only |
| 2 | Trivy image scan on deploy builds | security, infra | medium | S | Step after each Docker build in `deploy-production.yml` before GHCR push; fail on Critical / report on High |
| 3 | gitleaks secrets scanning (pre-commit + nightly history) | security, infra | high | S | `.husky/pre-commit` step + nightly full-history job; `.gitleaks.toml` allowlist for compose `*-change-me` throwaways |
| 4 | SBOM per image (Syft → CycloneDX) | security, infra | medium | S | SBOM artifact per image build; deploy runbook updated |
| 5 | SECURITY.md disclosure policy | security, docs | medium | S | Contact, scope (approved test tenants only), SLA bands, safe harbor |
| 6 | Adopt review tooling (`/security-review` on auth/tenancy/uploads/crypto PRs; evaluate `security-guidance` + `code-modernization:security-auditor`) | security, infra | medium | S | Decision recorded; CONTEXT/CLAUDE pointer in a close-out commit |
| 7 | Authenticated DAST lane (OWASP ZAP vs local compose stack) | security, infra | high | M | `npm run local:dast` against the `test` tenant only; baseline report under `local-assets/` |
| 8 | Executable authz matrix spec — endpoint × role × tenant | security, api | high | L | Jest spec enumerating every controller route; asserts guard chain + cross-tenant 404/403; fails on any new unguarded route |
| 9 | Mobile MASVS pass (STORAGE/NETWORK/PLATFORM) | security, mobile | medium | M | Checklist over `apps/mobile/lib` auth/secure-key/oauth-state; findings to registry; cert-pinning decision |
| 10 | ASVS 5.0 L2 checklist pass + external pentest scoping | security | medium | L | L2 gaps listed; pentest RFP scope (approved test tenants, PTES phases); owner-action to procure |
| 11 | Mobile Docker runner non-root (F12-003 remainder) | security, infra | low | S | `apps/mobile/Dockerfile` runner uses `nginx-unprivileged` or adds `USER` |
| OPS | Next/React RSC CVE patch-level check (CVE-2025-55182/55183/55184, CVE-2026-23864) | security, infra | high | — | Due 2026-09-18, recurs per Next/React bump |

F12-003's remainder (mobile Docker runner still root) is tracked as Plane task 11 above — it is
not a bug-registry item.

### Registry — batch F48 (ids assigned at filing: B355–B360)

| Id | Finding | Severity | Tier |
| --- | --- | --- | --- |
| B355 | F11-002 — web tokens in `localStorage` | high | T2 |
| B356 | F5-003 — shared JWT signing secret / no identity-type claim | medium | T1 |
| B357 | F9-006 — `X-Forwarded-For` spoofing of throttler + audit IP | medium | T1 |
| B358 | F12-005 — mobile OAuth deep-link without PKCE/state | medium | T1 |
| B359 | F3-005 remainder — buyer registration enumeration via 409 | low | T1 |
| B360 | F4-003 remainder — 9 `@Body() dto: any` routes | low | T1 |

## 9. Sources

- [softwaremill.com — What's new in ASVS 5.0](https://softwaremill.com/whats-new-in-asvs-5-0/)
- [cybersigmacs.com — OWASP ASVS knowledge center](https://cybersigmacs.com/knowledge-center/owasp-asvs/)
- [orca.security — OWASP Top 10 2025 key changes](https://orca.security/resources/blog/owasp-top-10-2025-key-changes/)
- [about.gitlab.com — 2025 OWASP Top 10: what's changed](https://about.gitlab.com/blog/2025-owasp-top-10-whats-changed-and-why-it-matters/)
- [owasp.org — API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x00-toc/)
- [owasp.org — API Top 10 2023 blog announcement](https://owasp.org/blog/2023/07/03/owasp-api-top10-2023)
- [owasp.org — Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [mas.owasp.org — MASVS](https://mas.owasp.org/MASVS/)
- [mas.owasp.org — MASTG](https://mas.owasp.org/MASTG/)
- [owaspsamm.org — SAMM v2 model](https://owaspsamm.org/model/)
- [csrc.nist.gov — NIST SSDF (SP 800-218)](https://csrc.nist.gov/projects/ssdf)
- [nvlpubs.nist.gov — SP 800-218 PDF](https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-218.pdf)
- [cisa.gov — 2025 CWE Top 25](https://www.cisa.gov/news-events/alerts/2025/12/11/2025-cwe-top-25-most-dangerous-software-weaknesses)
- [mend.io — CVSS 3.1 vs 4.0, a look at the data](https://www.mend.io/blog/cvss-3-1-vs-cvss-4-0-a-look-at-the-data/)
- [kaimz.org — CVSS 4 vs 3.1 analysis](https://kaimz.org/cve-analysis/cvss-4-vs-3-1/)
- [ibm.com — Penetration testing methodology](https://www.ibm.com/think/insights/pen-testing-methodology)
- [safeguard.sh — Best SAST tools 2026](https://safeguard.sh/resources/blog/best-sast-tools-2026)
- [konvu.com — Semgrep vs CodeQL](https://konvu.com/compare/semgrep-vs-codeql)
- [appsecsanta.com — Semgrep vs Snyk](https://appsecsanta.com/sast-tools/semgrep-vs-snyk)
- [pkgpulse.com — Why npm audit is broken](https://www.pkgpulse.com/guides/why-npm-audit-is-broken)
- [pkgpulse.com — npm supply chain security guide 2026](https://www.pkgpulse.com/guides/npm-supply-chain-security-guide-2026)
- [dev.to — TruffleHog vs gitleaks vs GitHub secret scanning](https://dev.to/chintanshah35/trufflehog-vs-gitleaks-vs-github-secret-scanning-why-most-ci-scanners-fail-2026-1372)
- [appsecsanta.com — gitleaks vs TruffleHog](https://appsecsanta.com/secret-scanning-tools/gitleaks-vs-trufflehog)
- [guptadeepak.com — Top 5 DAST tools 2026](https://guptadeepak.com/tools/top-5-dast-tools-2026/)
- [penetrify.cloud — OWASP ZAP vs commercial scanning tools 2026](https://www.penetrify.cloud/en/blog/owasp-zap-vs-commercial-scanning-tools-in-2026-an-honest-comparison-plus-nikto-nuclei-and-friends-owasp-zap-vs-commercial-tools/)
- [aikido.dev — Top container scanning tools](https://www.aikido.dev/blog/top-container-scanning-tools)
- [lucaberton.com — Trivy vs Grype 2026](https://lucaberton.com/blog/trivy-vs-grype-2026/)
- [oneuptime.com — Docker Scout vs Trivy](https://oneuptime.com/blog/post/2026-02-08-how-to-compare-docker-scout-vs-trivy-for-vulnerability-scanning/view)
- [appsecsanta.com — SBOM tools comparison](https://appsecsanta.com/sca-tools/sbom-tools-comparison)
- [github.com/anchore/syft](https://github.com/anchore/syft)
- [cyclonedx.org — Tool center](https://cyclonedx.org/tool-center/)
- [dev.to/guardr — securityheaders.com API migration](https://dev.to/guardr/securityheaderscom-api-is-gone-heres-the-migration-4461)
- [zeriflow.com — Mozilla Observatory alternative 2026](https://zeriflow.com/blog/mozilla-observatory-alternative-2026)
- [docs.nestjs.com — Rate limiting](https://docs.nestjs.com/security/rate-limiting)
- [secure.com — Vulnerability remediation SLAs](https://www.secure.com/blog/vulnerability-remediation-slas/)
- [strobes.co — SLAs for vulnerability management](https://strobes.co/blog/service-level-agreements-sla-for-vulnerability-management/)
- [offsec.com — CVE-2025-29927](https://www.offsec.com/blog/cve-2025-29927/)
- [projectdiscovery.io — Next.js middleware authorization bypass](https://projectdiscovery.io/blog/nextjs-middleware-authorization-bypass)
- [react.dev — Critical security vulnerability in React Server Components](https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components)
- [react.dev — DoS and source code exposure in RSC](https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components)
- [microsoft.com — Defending against CVE-2025-55182 React2Shell](https://www.microsoft.com/en-us/security/blog/2025/12/15/defending-against-the-cve-2025-55182-react2shell-vulnerability-in-react-server-components/)
- [cisa.gov — Widespread npm supply chain compromise (Shai-Hulud)](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)
- [microsoft.com — Shai-Hulud 2.0 guidance](https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/)
- [unit42.paloaltonetworks.com — npm supply chain attack](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/)
- [equixly.com — OWASP Top 10 2025 vs 2021](https://equixly.com/blog/2025/12/01/owasp-top-10-2025-vs-2021/)
