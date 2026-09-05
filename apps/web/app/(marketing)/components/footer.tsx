import Link from "next/link";
import { Logo } from "./logo";

// Columns are intentionally minimal: every link goes to a page that actually
// exists and has real content. Anything we don't have yet (legal pages,
// social accounts, app store listings, help center) is just left out — better
// than dead `#` links or routes that 404 / loop back to /company.
const COLUMNS: Array<[string, Array<[string, string]>]> = [
  [
    "Product",
    [
      ["Features", "/product"],
      ["For wholesalers", "/wholesalers"],
      ["For retailers", "/retailers"],
      ["Pricing", "/pricing"],
    ],
  ],
  [
    "Company",
    [
      ["About", "/company"],
      ["Contact", "/contact"],
    ],
  ],
  [
    "Sign in",
    [
      ["Wholesaler portal", "/login"],
      ["Buyer portal", "/buyer/login"],
    ],
  ],
];

export function MarketingFooter() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 1fr 1fr 1fr",
            gap: 48,
            paddingBottom: 48,
            borderBottom: "1px solid rgba(250,246,238,0.12)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <Logo size={32} dark />
              <span
                style={{
                  fontFamily: "var(--rf-display)",
                  fontSize: 24,
                  color: "var(--rf-cream)",
                }}
              >
                RouteFlow
              </span>
            </div>
            <p
              style={{
                fontSize: 14,
                color: "rgba(250,246,238,0.6)",
                lineHeight: 1.6,
                maxWidth: 320,
                marginBottom: 16,
              }}
            >
              The operating system for distribution. Connecting wholesalers and the retailers they
              serve.
            </p>
            <a
              href="mailto:hello@routeflow.info"
              style={{
                fontSize: 13,
                color: "rgba(250,246,238,0.7)",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              hello@routeflow.info
            </a>
          </div>

          {COLUMNS.map(([title, links]) => (
            <div key={title}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--rf-cream)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  marginBottom: 16,
                }}
              >
                {title}
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {links.map(([label, href]) => (
                  <Link key={label} href={href} style={{ fontSize: 13 }}>
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            padding: "28px 0 8px",
            fontSize: 12,
            color: "rgba(250,246,238,0.5)",
          }}
        >
          © {new Date().getFullYear()} RouteFlow · Austin, Texas
        </div>
      </div>

      {/* Tail mark */}
      <div
        style={{
          marginTop: 24,
          padding: "0 32px",
          maxWidth: 1240,
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        <div
          className="display footer-tail-mark"
          style={{
            fontSize: "min(22vw, 280px)",
            lineHeight: 0.85,
            color: "rgba(250,246,238,0.06)",
            letterSpacing: "-0.04em",
            textAlign: "center",
            overflow: "hidden",
          }}
        >
          RouteFlow
        </div>
      </div>
    </footer>
  );
}
