import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Brand } from "@/components/brand";
import { site } from "../lib/site";
import { authLinks } from "./auth-links";

// Preview-only lines from the redesign are deliberately dropped here:
// "Explore the redesigned account screens.", "Explore sample workspace",
// "Account design previews. No live sign-in.", "Website design preview ·
// Review status" (spec.md R2).
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-top">
          <div className="footer-brand">
            <Brand className="brand" />
            <p>Keep your delivery day on track.</p>
            <a href={`mailto:${site.email}`}>
              {site.email} <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>

          <div>
            <h2>Platform</h2>
            <Link href="/product">Product overview</Link>
            <Link href="/wholesalers">For distributors</Link>
            <Link href="/retailers">For retailers</Link>
            <Link href="/pricing">Pricing</Link>
          </div>

          <div>
            <h2>Company</h2>
            <Link href="/company">About RouteFlow</Link>
            <Link href="/book-a-demo">Book a demo</Link>
            <Link href="/contact">Contact us</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </div>

          <div>
            <h2>Your workspace</h2>
            <a href={authLinks.distributorSignIn}>
              Distributor sign in <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <a href={authLinks.distributorSignUp}>Create distributor account</a>
            <a href={authLinks.retailerSignIn}>
              Retailer sign in <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <a href={authLinks.retailerSignUp}>
              Create retailer account <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} RouteFlow</span>
        </div>
      </div>
    </footer>
  );
}
