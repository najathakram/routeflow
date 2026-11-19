# Check: the production EMAIL_FROM setting

This is a draft of a read-only check. The lead runs the read. This page gives no command and touches nothing in production.

## Why it matters

From launch, the name in the "From" line of every platform email comes from the brand file, not from the setting. Before, the display name came from the setting (for example "RouteFlow"). Now the code takes only the address part of the setting and puts the brand name in front of it. So a new customer's first email reads "Rovio" from the same sending address as today.

If the address part is wrong or unusual, the new name sits on top of a bad address. A verify email that looks odd or fails delivery means a new payer never confirms the trial.

## What to read

Read one value in production: `EMAIL_FROM`. Then answer four questions.

1. **Is it set?**
   - If it is not set, the code uses `invoices@send.routeflow.info`. That is fine. Write down "not set".
   - If the service sends by SMTP and `EMAIL_FROM` is not set, the From address is the SMTP user. Check which mode production uses.
2. **What is the address part?** It is the part inside the angle brackets, or the whole value if there are none.
   - Expected: an address on `send.routeflow.info`. That is the domain with the SPF, DKIM and DMARC records, and the plan keeps it unchanged.
   - If it is any other domain, stop and tell the lead. The plan assumes no mail record changes.
3. **Does the value parse?** Look for a display name with odd characters, two addresses, or missing brackets. The code takes the address part only, so a messy display name is harmless. A messy address is not.
4. **Is there a display name in it?** Probably "RouteFlow". The code ignores it from launch. It does no harm. It only looks stale. Note it for a later tidy-up.

Do not copy the value into a chat, a ticket or a file. Write down only the answers: set or not set, the domain of the address, parses or not.

## The decision it feeds

| What the read shows | Decision |
|---|---|
| Address on `send.routeflow.info`, parses | Nothing to change. Launch as planned. |
| Not set, or SMTP user in use | Confirm the fallback address is on the same domain. If yes, nothing to change. If no, the owner decides before launch. |
| Address on another domain | Stop. The owner and the lead decide: keep that address, or move to `send.routeflow.info`. Moving needs mail record work and is not in the plan. |
| Value does not parse | Fix the value in a separate step before launch. |

## After the decision, on launch day

The plan already holds this check: send one platform email to a Gmail test inbox and one to an Outlook test inbox. Both must show SPF, DKIM and DMARC as pass. The From name should read "Rovio" (or the fallback name).

Tenant emails are not affected. A tenant's own mail keeps the tenant's name. The platform name appears only in "Sent with ..." and "... via ...".

## Open points

- This check does not say which mailbox receives replies. Nothing in the plan changes that. If the owner wants replies to go to hello@xrovio.com, that needs its own decision.
- The sending address keeps the old domain name until a later step. A customer who opens the full email details will still see it. The notice does not claim otherwise.

Source: email spec (sender rule), spec delta section 2 (sender domain stays, no SPF/DKIM change).
