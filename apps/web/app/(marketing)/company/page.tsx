import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon } from "../components/icons";

export const metadata: Metadata = {
  title: "Company",
  description:
    "RouteFlow was started by people who'd actually run distribution businesses, not by people who'd read about them.",
};

const VALUES = [
  {
    title: "Real businesses, not slide decks",
    body: "We test every feature against actual distributors' real operations before shipping. If it doesn't help on Monday morning, it doesn't ship.",
  },
  {
    title: "Built for North America, useful anywhere",
    body: "English & Spanish, voice-first, works on patchy rural connections. Designed for the realities our customers operate in.",
  },
  {
    title: "Software that gets out of the way",
    body: "The best moments using RouteFlow are when you stop noticing it's there. Less software, more business.",
  },
];

export default function CompanyPage() {
  return (
    <>
      <section style={{ padding: "80px 0 64px" }}>
        <div className="wrap-narrow" style={{ textAlign: "center" }}>
          <div
            className="eyebrow"
            style={{ display: "inline-flex", justifyContent: "center", marginBottom: 16 }}
          >
            <span className="dot" /> Company
          </div>
          <h1 className="display" style={{ fontSize: 80, margin: 0 }}>
            We grew up
            <br />
            in the <em>warehouse.</em>
          </h1>
          <p
            style={{
              fontSize: 18,
              color: "var(--rf-ink-3)",
              marginTop: 24,
              lineHeight: 1.55,
            }}
          >
            RouteFlow was started by people who&apos;d actually run distribution businesses, not by
            people who&apos;d read about them.
          </p>
        </div>
      </section>

      <section
        className="sect"
        style={{
          background: "var(--rf-paper)",
          borderTop: "1px solid var(--rf-line)",
          borderBottom: "1px solid var(--rf-line)",
        }}
      >
        <div className="wrap">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 80,
              alignItems: "center",
            }}
          >
            <div>
              <h2 className="display" style={{ fontSize: 48, margin: "0 0 20px" }}>
                Our story
              </h2>
              <p
                style={{
                  fontSize: 16,
                  color: "var(--rf-ink-2)",
                  lineHeight: 1.7,
                  marginBottom: 16,
                }}
              >
                Our founders ran a multi-van FMCG distribution business across Central Texas. They
                watched their team pour 4 hours a day into reconciling phone orders, scribbled
                diaries and QuickBooks entries — only to lose collections to forgotten follow-ups
                anyway.
              </p>
              <p
                style={{
                  fontSize: 16,
                  color: "var(--rf-ink-2)",
                  lineHeight: 1.7,
                  marginBottom: 16,
                }}
              >
                They tried every tool on the market. Nothing fit. Everything was either built for
                e-commerce sellers, or for enterprises with full-time IT teams. Nothing was built
                for the American wholesale trade — the shopkeeper-to-shopkeeper economy that moves
                the country.
              </p>
              <p
                style={{ fontSize: 16, color: "var(--rf-ink-2)", lineHeight: 1.7 }}
              >
                So they built RouteFlow. First for themselves, then for the distributors next door.
                Today it&apos;s the operating system we always wished existed.
              </p>
            </div>
            <div
              style={{
                background: "linear-gradient(135deg, #C75A3D 0%, #4B2C5E 100%)",
                borderRadius: 18,
                aspectRatio: "1",
                padding: 40,
                display: "grid",
                placeItems: "center",
                color: "var(--rf-cream)",
              }}
            >
              <div style={{ textAlign: "center" }}>
                <div
                  className="display"
                  style={{ fontSize: 56, color: "var(--rf-cream)", lineHeight: 1.05 }}
                >
                  Built for distributors of every size
                </div>
                <div
                  style={{
                    fontSize: 14,
                    opacity: 0.85,
                    marginTop: 16,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                  }}
                >
                  From one van to fifty
                </div>
                <div
                  style={{
                    height: 1,
                    background: "rgba(255,255,255,0.2)",
                    margin: "32px 0",
                  }}
                />
                <div
                  className="display"
                  style={{ fontSize: 32, color: "var(--rf-cream)", lineHeight: 1.1 }}
                >
                  Operating from
                  <br />
                  <em>Austin, Texas</em>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="sect">
        <div className="wrap">
          <h2
            className="display"
            style={{ fontSize: 48, margin: "0 0 40px", textAlign: "center" }}
          >
            What we <em>care about.</em>
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 24,
            }}
          >
            {VALUES.map((v, i) => (
              <div key={v.title} className="card" style={{ padding: 28 }}>
                <div
                  className="display"
                  style={{ fontSize: 32, color: "var(--rf-teal)", marginBottom: 14 }}
                >
                  0{i + 1}
                </div>
                <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>{v.title}</div>
                <div
                  style={{ fontSize: 14, color: "var(--rf-ink-3)", lineHeight: 1.6 }}
                >
                  {v.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact */}
      <section
        className="sect"
        style={{ background: "var(--rf-cream-2)", borderTop: "1px solid var(--rf-line)" }}
      >
        <div className="wrap-narrow" style={{ textAlign: "center" }}>
          <h2 className="display" style={{ fontSize: 56, margin: "0 0 20px" }}>
            Get in <em>touch.</em>
          </h2>
          <p
            style={{
              fontSize: 16,
              color: "var(--rf-ink-2)",
              lineHeight: 1.6,
              marginBottom: 32,
              maxWidth: 560,
              marginInline: "auto",
            }}
          >
            Want a guided walkthrough? Have a question about the platform? Need to talk pricing for
            a large operation? We&apos;re real people on the other end.
          </p>
          <div
            style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}
          >
            <Link href="/contact" className="btn btn-primary btn-lg">
              Book a demo <ArrowIcon />
            </Link>
            <a
              href="mailto:hello@routeflow.app"
              className="btn btn-ghost btn-lg"
            >
              Email us
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
