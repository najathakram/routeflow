// Retailer app "Tracking" screen mock — appears inside <PhoneShell>.

export function PhoneTracking() {
  const steps: Array<[string, string, boolean, "active" | undefined]> = [
    ["Confirmed", "9:14 AM", true, undefined],
    ["Packed", "10:02 AM", true, undefined],
    ["Out for delivery", "ETA 11:42", true, "active"],
    ["Delivered", "—", false, undefined],
  ];

  return (
    <div style={{ padding: "8px 14px 14px" }}>
      <div style={{ fontFamily: "var(--rf-display)", fontSize: 18, letterSpacing: "-0.02em" }}>
        Order #2451
      </div>
      <div style={{ fontSize: 11, color: "var(--rf-ink-3)" }}>Cascade Wholesale</div>
      <div
        style={{
          marginTop: 14,
          padding: 12,
          background: "var(--rf-paper)",
          border: "1px solid var(--rf-line)",
          borderRadius: 14,
        }}
      >
        {steps.map(([label, time, done, state], i) => (
          <div
            key={label}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              paddingBottom: i < steps.length - 1 ? 12 : 0,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: done
                    ? state === "active"
                      ? "var(--rf-teal-bright)"
                      : "var(--rf-teal)"
                    : "var(--rf-line-2)",
                  border: state === "active" ? "3px solid var(--rf-teal-50)" : "none",
                }}
              />
              {i < steps.length - 1 && (
                <div
                  style={{
                    width: 1.5,
                    flex: 1,
                    minHeight: 20,
                    background: done ? "var(--rf-teal)" : "var(--rf-line)",
                  }}
                />
              )}
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: done ? "var(--rf-ink)" : "var(--rf-ink-4)",
                }}
              >
                {label}
              </div>
              <div style={{ fontSize: 10, color: "var(--rf-ink-3)" }}>{time}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
