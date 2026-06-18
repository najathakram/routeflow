import { AppleIcon, AndroidIcon, LinkIcon } from "./icons";
import { PhoneShell } from "./mocks/phone-shell";
import { PhoneShop } from "./mocks/phone-shop";
import { PhoneRetailerHome } from "./mocks/phone-retailer-home";
import { PhoneTracking } from "./mocks/phone-tracking";

// Retailer app pitch — three phones + download CTAs. Used on home.
export function GetAppSection() {
  return (
    <section
      className="sect"
      style={{
        background: "var(--rf-ink)",
        color: "var(--rf-cream)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: -200,
          left: -100,
          width: 500,
          height: 500,
          background: "radial-gradient(circle, rgba(20,163,159,0.2), transparent 70%)",
          borderRadius: "50%",
          filter: "blur(40px)",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          bottom: -150,
          right: -100,
          width: 400,
          height: 400,
          background: "radial-gradient(circle, rgba(224,226,107,0.1), transparent 70%)",
          borderRadius: "50%",
          filter: "blur(40px)",
        }}
      />

      <div className="wrap" style={{ position: "relative" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.1fr 1fr",
            gap: 64,
            alignItems: "center",
          }}
        >
          <div>
            <div className="eyebrow" style={{ marginBottom: 20, color: "var(--rf-teal-bright)" }}>
              <span className="dot" style={{ background: "var(--rf-teal-bright)" }} /> The retailer
              app
            </div>
            <h2 className="display" style={{ fontSize: 64, margin: 0, color: "var(--rf-cream)" }}>
              Reorder in
              <br />
              two <em style={{ color: "var(--rf-teal-bright)" }}>taps.</em>
            </h2>
            <p
              style={{
                fontSize: 17,
                color: "rgba(250,246,238,0.7)",
                margin: "20px 0 32px",
                maxWidth: 480,
                lineHeight: 1.55,
              }}
            >
              Built for corner stores and bodegas, salons, restaurants and any small business that
              orders stock from suppliers. Voice-first, English &amp; Spanish, works on any phone.
            </p>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "11px 18px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.08)",
                  color: "rgba(250,246,238,0.7)",
                  fontSize: 13,
                  fontWeight: 600,
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <AppleIcon /> iOS &amp; <AndroidIcon /> Android — coming soon
              </span>
              <a
                href="mailto:hello@routeflow.info?subject=Notify%20me%20when%20the%20RouteFlow%20Shop%20app%20launches"
                className="btn btn-ghost"
                style={{
                  borderColor: "rgba(250,246,238,0.2)",
                  color: "var(--rf-cream)",
                }}
              >
                <LinkIcon /> Notify me at launch
              </a>
            </div>

            <div
              style={{
                marginTop: 40,
                paddingTop: 32,
                borderTop: "1px solid rgba(250,246,238,0.1)",
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 32,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 32,
                    fontFamily: "var(--rf-display)",
                    color: "var(--rf-cream)",
                  }}
                >
                  Free
                </div>
                <div style={{ fontSize: 12, color: "rgba(250,246,238,0.6)", marginTop: 4 }}>
                  Forever, for retailers
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 32,
                    fontFamily: "var(--rf-display)",
                    color: "var(--rf-cream)",
                  }}
                >
                  EN&nbsp;/&nbsp;ES
                </div>
                <div style={{ fontSize: 12, color: "rgba(250,246,238,0.6)", marginTop: 4 }}>
                  English &amp; Spanish, voice-first
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 32,
                    fontFamily: "var(--rf-display)",
                    color: "var(--rf-cream)",
                  }}
                >
                  22 MB
                </div>
                <div style={{ fontSize: 12, color: "rgba(250,246,238,0.6)", marginTop: 4 }}>
                  Light enough for any phone
                </div>
              </div>
            </div>
          </div>

          {/* Three phones */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              position: "relative",
              height: 540,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "0%",
                transform: "rotate(-6deg) scale(0.85)",
                zIndex: 1,
                opacity: 0.7,
              }}
            >
              <PhoneShell>
                <PhoneShop />
              </PhoneShell>
            </div>
            <div style={{ position: "absolute", left: "30%", zIndex: 3 }}>
              <PhoneShell>
                <PhoneRetailerHome />
              </PhoneShell>
            </div>
            <div
              style={{
                position: "absolute",
                right: "0%",
                transform: "rotate(6deg) scale(0.85)",
                zIndex: 1,
                opacity: 0.7,
              }}
            >
              <PhoneShell>
                <PhoneTracking />
              </PhoneShell>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
