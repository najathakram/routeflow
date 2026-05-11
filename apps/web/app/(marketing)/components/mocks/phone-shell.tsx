import type { ReactNode } from "react";

// Stylized iPhone frame used to wrap the retailer-app screen mocks.
export function PhoneShell({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div style={{ width: 248, position: "relative" }}>
      <div
        style={{
          background: "var(--rf-ink)",
          padding: 7,
          borderRadius: 36,
          boxShadow: "0 30px 60px -20px rgba(14,31,54,0.4), 0 0 0 1px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            background: "var(--rf-cream)",
            borderRadius: 30,
            overflow: "hidden",
            aspectRatio: "9/19",
          }}
        >
          <div
            style={{
              height: 28,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0 18px",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <span>9:41</span>
            <span>•••</span>
          </div>
          {children}
        </div>
      </div>
      {label && (
        <div
          style={{
            textAlign: "center",
            marginTop: 16,
            fontSize: 12,
            color: "var(--rf-ink-3)",
            fontFamily: "var(--rf-mono)",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
