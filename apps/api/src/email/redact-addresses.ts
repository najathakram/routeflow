/**
 * Moved out of email.service.ts so `EmailDeliveryService` can use it without an import cycle
 * (email.service.ts imports email-delivery.service.ts for DI). `email.service.ts` re-exports it, so
 * every existing `import { redactAddresses } from "./email.service"` is unchanged.
 */

/** Upper bound on the text redactAddresses returns (it runs on remote server responses). */
const REDACT_MAX_INPUT = 4096;
/**
 * Hard pre-cap applied BEFORE the regexes run (the ReDoS bound). REDACT_MAX_INPUT is applied AFTER
 * masking, so an address straddling the 4096 boundary can never leak a partial local part.
 */
const REDACT_PRE_CAP = 65536;

/**
 * Strip IPv4/IPv6 address literals AND email addresses (local part masked, domain kept) from
 * an error string (see mapSmtpError fallback; also the Resend error text we log).
 *
 * This runs on text a remote, tenant-controlled SMTP host chooses, so it must not be a
 * ReDoS surface: the input is hard-capped to REDACT_PRE_CAP first, and every quantifier is
 * BOUNDED (unquoted local part {1,64}, quoted local part {1,62} of disjoint alternatives,
 * domain labels {1,63} x {1,8}; IPv6 groups {0,4}/{2,8}). An unbounded `[...]+@` pattern
 * backtracks quadratically on a long no-`@` string (50k chars blocked the event loop for
 * ~12 s). The local part accepts an apostrophe (`o'brien@`) and a quoted string
 * (`"jane doe"@`, escapes allowed). The IPv6 pattern is intentionally NOT
 * \b-anchored at the start and requires >=2 colon groups: that catches "::"-compressed
 * forms Node actually emits (e.g. "::1:587", ":::53408"), which a \b-anchored pattern would
 * miss. Over-redaction of address-shaped tokens in this fallback branch is acceptable. The email
 * pattern needs a dotted domain, so a bare `user@localhost` is deliberately not masked.
 */
export function redactAddresses(msg: string): string {
  return (
    msg
      .slice(0, REDACT_PRE_CAP)
      // Email addresses: keep the domain (what an operator needs), mask the local part (PII).
      .replace(
        /(?:[A-Za-z0-9._%+'-]{1,64}|"(?:[^"\\\r\n]|\\.){1,62}")@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8})/g,
        "***@$1",
      )
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[address]") // IPv4 (and IPv4-mapped tail)
      .replace(/(?:[0-9a-f]{0,4}:){2,8}[0-9a-f]{0,4}/gi, "[address]") // IPv6 incl. ::-compressed
      .slice(0, REDACT_MAX_INPUT)
  );
}
