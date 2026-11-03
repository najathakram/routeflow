import Link from "next/link";
import { SiteFrame } from "@/components/site-frame/SiteFrame";

// The 404 page wears the site frame (components/site-frame): same header and footer as every page.
export default function NotFound() {
  return (
    <SiteFrame>
      <div className="rf-notfound">
        <p className="kick">404</p>
        <h1>We can’t find that page.</h1>
        <p>It may have moved, or the address may have a typo. Go back to the home page.</p>
        <Link href="/" className="btn btn-primary btn-lg">
          Back to RouteFlow
        </Link>
      </div>
    </SiteFrame>
  );
}
