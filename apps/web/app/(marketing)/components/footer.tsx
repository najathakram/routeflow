import Link from "next/link";
import { Logo } from "./logo";
import { AppleIcon, AndroidIcon } from "./icons";

const COLUMNS: Array<[string, Array<[string, string]>]> = [
  [
    "Product",
    [
      ["Features", "/product"],
      ["For wholesalers", "/wholesalers"],
      ["For retailers", "/retailers"],
      ["Pricing", "/pricing"],
      ["Mobile app", "/retailers"],
    ],
  ],
  [
    "Company",
    [
      ["About", "/company"],
      ["Contact", "/contact"],
      ["Customers", "/"],
    ],
  ],
  [
    "Resources",
    [
      ["Help center", "/company"],
      ["Sign in (wholesaler)", "/login"],
      ["Sign in (retailer)", "/buyer/login"],
    ],
  ],
  [
    "Legal",
    [
      ["Terms", "/company"],
      ["Privacy", "/company"],
      ["Security", "/company"],
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
            gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr",
            gap: 48,
            paddingBottom: 64,
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
                marginBottom: 24,
              }}
            >
              The operating system for distribution. Connecting wholesalers and the retailers they
              serve.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a
                href="#"
                className="btn"
                style={{
                  background: "rgba(255,255,255,0.08)",
                  color: "var(--rf-cream)",
                  padding: "8px 14px",
                  fontSize: 12,
                }}
              >
                <AppleIcon /> App Store
              </a>
              <a
                href="#"
                className="btn"
                style={{
                  background: "rgba(255,255,255,0.08)",
                  color: "var(--rf-cream)",
                  padding: "8px 14px",
                  fontSize: 12,
                }}
              >
                <AndroidIcon /> Google Play
              </a>
            </div>
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
            padding: "32px 0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 16,
            fontSize: 12,
            color: "rgba(250,246,238,0.5)",
          }}
        >
          <div>© {new Date().getFullYear()} RouteFlow · Austin, Texas</div>
          <div style={{ display: "flex", gap: 16 }}>
            <a href="#">Twitter</a>
            <a href="#">LinkedIn</a>
            <a href="#">YouTube</a>
          </div>
        </div>
      </div>

      {/* Tail mark */}
      <div style={{ marginTop: 24, padding: "0 32px", maxWidth: 1240, marginLeft: "auto", marginRight: "auto" }}>
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
