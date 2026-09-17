# Security Policy

RouteFlow takes the security of our platform and our customers' data seriously. We
appreciate the work of good-faith security researchers and welcome reports of
vulnerabilities.

## Reporting a vulnerability

Email **security@routeflow.info** with a description of the issue, the steps to
reproduce it, and its potential impact. Please do not open a public GitHub issue for a
security report.

- We will acknowledge your report within **72 hours**.
- We will investigate and aim to provide a fix or mitigation within **90 days** of
  confirming the issue, and will keep you informed of progress along the way. Timelines
  vary with severity and complexity — a critical, actively exploitable issue is treated
  as a priority.
- We will let you know once the issue is resolved and, if you'd like, credit you in our
  release notes.

## Scope

**In scope:** the production RouteFlow application and API (`www.routeflow.info` and its
API), and this source repository.

**Out of scope:**

- Denial-of-service or availability-impacting testing (load testing, resource
  exhaustion, automated scanners that generate high traffic volumes).
- Social engineering, phishing, or physical attacks against RouteFlow staff, customers,
  or offices.
- Vulnerabilities in third-party services we integrate with (Stripe, Google, Railway,
  and other providers) — please report those directly to the provider.
- Findings that require a jailbroken/rooted device or an already-compromised account or
  machine.

## Testing guidelines

If you need to create an account or generate data to test with, use a throwaway tenant
(a `qa-*`, `e2e-*`, or similar disposable slug) rather than a real business's account. Do
not attempt to access, modify, or exfiltrate another tenant's or customer's data — a
proof of concept that demonstrates a cross-tenant access issue should stop at
confirming the issue exists, not read or retain the underlying data. Please make a
good-faith effort to avoid privacy violations, data destruction, and service
disruption during your research.

## Safe harbor

We consider security research conducted consistent with this policy to be authorized.
We will not pursue legal action against researchers who make a good-faith effort to
comply with this policy, report vulnerabilities promptly, and avoid privacy violations,
data destruction, and service disruption. This safe harbor does not extend to testing
against third-party services or to any activity described as out of scope above.

## Not a bug bounty

We do not currently offer paid bug bounties. We're grateful for reports regardless, and
will credit researchers who wish to be credited once an issue is resolved.
