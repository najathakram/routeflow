// B2: one resend call for the check-email page and the expired-link state of verify-email.
// The endpoint is deliberately enumeration-safe (always 200, same body), so "sent" never proves
// delivery for a real account; a non-2xx (429 included) or a network failure is "failed".

export const RESEND_SENT_COPY = "If that address has a pending account, a new link is on its way.";
export const RESEND_FAILED_COPY = "Something went wrong. Please try again in a moment.";

export async function requestVerificationResend(email: string): Promise<"sent" | "failed"> {
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";
  try {
    const res = await fetch(`${apiUrl}/public/tenants/resend-verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
