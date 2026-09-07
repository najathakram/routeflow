import Link from "next/link";
import { Brand } from "@/components/brand";

// Restyled per ux-spec.md §3 (spec.md R1, R4): eyebrow, H1, body, one CTA.
// Not under the `(marketing)` route group, so the mark/wordmark and the
// `.rf-marketing` scope are applied directly here rather than inherited from
// `app/(marketing)/layout.tsx`.
export default function NotFound() {
  return (
    <div className="rf-marketing">
      <main id="main-content" className="not-found wrap">
        <Brand size={40} className="not-found-brand" />
        <p className="eyebrow">
          <span />
          404 · PAGE NOT FOUND
        </p>
        <h1>
          Let’s get you <br />
          <em>back on track.</em>
        </h1>
        <p>
          The page you’re looking for isn’t here. Explore the platform or return to the homepage.
        </p>
        <Link href="/" className="button">
          Back to RouteFlow <span aria-hidden="true">→</span>
        </Link>
      </main>
    </div>
  );
}
