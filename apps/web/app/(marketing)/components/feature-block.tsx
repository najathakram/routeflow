import type { ReactNode } from "react";
import { CheckIcon } from "./icons";

export interface FeatureBlockBody {
  intro: string;
  points: Array<[string, string]>;
}

// Alternating left/right product feature row used by /product.
export function FeatureBlock({
  eyebrow,
  title,
  body,
  mock,
  reverse = false,
}: {
  eyebrow: string;
  title: ReactNode;
  body: FeatureBlockBody;
  mock: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="sect" style={{ borderTop: "1px solid var(--rf-line)" }}>
      <div className="wrap">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 80,
            alignItems: "center",
          }}
        >
          <div style={{ order: reverse ? 2 : 1 }}>
            <div className="eyebrow" style={{ marginBottom: 16 }}>
              <span className="dot" /> {eyebrow}
            </div>
            <h2 className="display" style={{ fontSize: 52, margin: "0 0 20px" }}>
              {title}
            </h2>
            <p
              style={{
                fontSize: 16,
                color: "var(--rf-ink-2)",
                lineHeight: 1.6,
                marginBottom: 24,
              }}
            >
              {body.intro}
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 14 }}>
              {body.points.map(([head, sub]) => (
                <li key={head} style={{ display: "flex", gap: 14 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: "var(--rf-teal-50)",
                      color: "var(--rf-teal-deep)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    <CheckIcon />
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>{head}</div>
                    <div style={{ fontSize: 14, color: "var(--rf-ink-3)", lineHeight: 1.5 }}>
                      {sub}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ order: reverse ? 1 : 2 }}>{mock}</div>
        </div>
      </div>
    </section>
  );
}
