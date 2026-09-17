import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { routes, site } from "../lib/site";
import { Eyebrow } from "../components/marketing";

// Published terms of service (R9 follow-up). Source draft:
// local-assets/handoff/2026-09-17/legal/terms-of-service-DRAFT.md — this page carries the
// full text, not the interim shell. `LAST_UPDATED` also feeds the visible "Last updated"
// line below; bump both together when the terms change.
const LAST_UPDATED = "September 17, 2026";

const route = routes.find((r) => r.slug === "terms")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/terms",
    siteName: site.name,
    type: "website",
  },
};

export default function TermsPage() {
  return (
    <div className="glass-page">
      <section className="legal-page wrap">
        <Eyebrow>ROUTEFLOW</Eyebrow>
        <h1>Terms of Service</h1>
        <p>
          <strong>Effective date:</strong> {LAST_UPDATED}
          <br />
          <strong>Last updated:</strong> {LAST_UPDATED}
        </p>

        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of the RouteFlow
          platform — a multi-tenant software-as-a-service application for wholesale distributors
          that manages orders, delivery routes, invoices, payments, a buyer portal, and
          driver/operator mobile apps (collectively, the &ldquo;Service&rdquo;) — provided by
          Routeflow Solutions LLC, a Wyoming limited liability company (&ldquo;RouteFlow,&rdquo;
          &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;).
        </p>
        <p>
          By creating an account, signing an order form, or otherwise accessing or using the
          Service, you agree to these Terms on behalf of yourself and, if applicable, the business
          or organization you represent (a &ldquo;Tenant&rdquo; or &ldquo;Customer&rdquo;). If you
          do not agree, do not use the Service.
        </p>

        <h2 id="accounts">1. Accounts and roles</h2>
        <p>RouteFlow is designed for business use across several types of accounts:</p>
        <ul>
          <li>
            <strong>Tenant (Customer) accounts</strong> — a wholesale distribution business that
            subscribes to RouteFlow and creates its own operator/staff accounts.
          </li>
          <li>
            <strong>Staff / operator accounts</strong> — users the Tenant invites to manage orders,
            routes, invoices, and customers within the Tenant&rsquo;s account.
          </li>
          <li>
            <strong>Driver accounts</strong> — users the Tenant invites to run delivery routes via
            the mobile app.
          </li>
          <li>
            <strong>Buyer (customer portal) accounts</strong> — the Tenant&rsquo;s own customers,
            who may be given access to a self-service buyer portal to place orders and view
            invoices.
          </li>
        </ul>
        <p>
          You must provide accurate information when creating an account and are responsible for
          maintaining the confidentiality of your login credentials and for all activity under your
          account. Notify us promptly at{" "}
          <a href="mailto:security@routeflow.info">security@routeflow.info</a> if you suspect
          unauthorized access.
        </p>

        <h2 id="the-service">2. The Service</h2>
        <p>
          RouteFlow provides tools for order management, route planning and optimization, invoicing,
          payments (including credit and, where enabled, post-dated check payments), a buyer
          self-service portal, and driver/operator mobile apps for route execution and proof of
          delivery. Specific features available to a Tenant depend on its subscription plan and any
          add-ons it has purchased or been granted.
        </p>
        <p>
          We may modify, add, or remove features of the Service over time. We will make reasonable
          efforts to notify Tenants of material changes that reduce core functionality.
        </p>

        <h2 id="billing">3. Subscriptions, billing, and payment</h2>
        <ul>
          <li>
            Paid plans are billed on a subscription basis (monthly/annual, as selected) through our
            payment processor, <strong>Stripe</strong>. By subscribing, you authorize us (via
            Stripe) to charge your payment method on a recurring basis until you cancel.
          </li>
          <li>
            Fees are described at{" "}
            <Link href="/pricing">{site.origin.replace(/^https?:\/\//, "")}/pricing</Link> or in
            your order form, and are exclusive of taxes unless stated otherwise.
          </li>
          <li>Fees already paid are non-refundable.</li>
          <li>
            You may cancel your subscription at any time through account settings or by contacting{" "}
            <a href={`mailto:${site.email}`}>{site.email}</a>; cancellation stops the next renewal,
            and your access continues through the end of the current paid period.
          </li>
          <li>
            We may suspend or downgrade access for a Tenant account with a failed or overdue
            payment, after reasonable notice.
          </li>
        </ul>

        <h2 id="acceptable-use">4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>
            use the Service to violate any applicable law, regulation, or third party&rsquo;s
            rights;
          </li>
          <li>
            upload, store, or transmit content you do not have the right to share (e.g., another
            business&rsquo;s confidential data without authorization);
          </li>
          <li>
            attempt to gain unauthorized access to another Tenant&rsquo;s data, accounts, or
            systems, or to probe, scan, or test the vulnerability of the Service except as permitted
            by our{" "}
            <a
              href="https://github.com/najathakram/routeflow/blob/master/SECURITY.md"
              target="_blank"
              rel="noreferrer"
            >
              Security Policy
            </a>{" "}
            against approved test tenants;
          </li>
          <li>
            interfere with or disrupt the integrity or performance of the Service (e.g., excessive
            automated requests, denial-of-service activity);
          </li>
          <li>
            reverse engineer, decompile, or attempt to extract the source code of the Service,
            except to the extent applicable law expressly permits;
          </li>
          <li>
            use the Service to send unsolicited bulk communications (&ldquo;spam&rdquo;) or in a
            manner that would cause our email or messaging providers to flag or suspend our
            accounts; or
          </li>
          <li>
            resell, sublicense, or provide the Service to third parties outside your own
            organization except through features we expressly provide (e.g., the buyer portal).
          </li>
        </ul>
        <p>We may suspend or terminate access for a violation of this section.</p>

        <h2 id="tenant-data">5. Tenant data; controller/processor relationship</h2>
        <ul>
          <li>
            As between RouteFlow and a Tenant, the <strong>Tenant owns and controls</strong> the
            business data it and its users (staff, drivers, buyers) submit to the Service
            (&ldquo;Tenant Data&rdquo;), including customer records, orders, invoices, routes, and
            uploaded documents.
          </li>
          <li>
            RouteFlow processes Tenant Data <strong>solely to provide the Service</strong>, as
            described in our <Link href="/privacy">Privacy Policy</Link>, and does not use Tenant
            Data for any other purpose, including advertising.
          </li>
          <li>
            The Tenant is responsible for having the necessary rights and legal basis to submit its
            customers&rsquo; and drivers&rsquo; personal data to RouteFlow, and for responding to
            data subject requests from its own customers and drivers (RouteFlow will provide
            reasonable assistance).
          </li>
          <li>
            A Tenant may request a Data Processing Addendum by contacting{" "}
            <a href={`mailto:${site.email}`}>{site.email}</a>.
          </li>
        </ul>

        <h2 id="mobile-permissions">6. Location and device permissions (mobile app)</h2>
        <p>
          The RouteFlow mobile app requests the following device permissions to support core
          delivery functionality:
        </p>
        <ul>
          <li>
            <strong>Location</strong> — used to share a driver&rsquo;s location with
            dispatch/operators while an active delivery route is in progress, including briefly in
            the background so route progress keeps updating if the app is minimized. Location is not
            collected outside of an active route.
          </li>
          <li>
            <strong>Camera</strong> — used to scan product barcodes and to photograph receipts,
            supplier bills, product images, and proof of delivery.
          </li>
          <li>
            <strong>Photo library</strong> — used only when a user chooses to attach an existing
            photo (e.g., a receipt) instead of taking a new one.
          </li>
        </ul>
        <p>
          A Tenant&rsquo;s driver or staff member may decline these permissions, but doing so may
          prevent certain features (live route tracking, barcode scanning, photo proof of delivery)
          from working. See the <Link href="/privacy">Privacy Policy</Link> for more detail.
        </p>

        <h2 id="third-party-services">7. Third-party services</h2>
        <p>
          The Service integrates with or relies on third-party providers to operate, including
          payment processing (Stripe), hosting (Railway), authentication (Google Sign-In), maps and
          route optimization (Google Maps, OpenRouteService), transactional email (sent primarily
          through RouteFlow&rsquo;s own Google Workspace mailbox, with Resend as an automatic
          fallback), demo-meeting scheduling (Google Calendar, via a RouteFlow-owned service
          account), file storage (Cloudflare R2 / Railway volume), and optional integrations a
          Tenant may enable (e.g., GoHighLevel CRM sync, Zoho CRM import, AI-assisted document
          scanning). Use of these integrations may be subject to the applicable third party&rsquo;s
          own terms. RouteFlow is not responsible for the acts or omissions of independent
          third-party providers, except as expressly stated in these Terms or required by law.
        </p>
        <p>
          If you connect a third-party email account (Gmail or Microsoft 365/Outlook) using the
          &ldquo;Connect your email&rdquo; feature, you authorize RouteFlow to send email on your
          behalf using only the permissions you grant (send-only — RouteFlow never reads your
          mailbox). You can revoke this access at any time within the Service, which immediately
          deletes the stored connection.
        </p>

        <h2 id="intellectual-property">8. Intellectual property</h2>
        <ul>
          <li>
            RouteFlow and its licensors retain all right, title, and interest in and to the Service,
            including its software, design, and trademarks. These Terms do not grant you any rights
            to RouteFlow&rsquo;s intellectual property except the limited right to use the Service
            as permitted here.
          </li>
          <li>
            Subject to Section 5, you retain all rights to your Tenant Data. You grant RouteFlow a
            limited license to host, process, and display Tenant Data solely to provide the Service
            to you.
          </li>
          <li>
            If you send us feedback or suggestions about the Service, you grant RouteFlow a
            perpetual, irrevocable, royalty-free license to use that feedback without any obligation
            to you.
          </li>
        </ul>

        <h2 id="term-termination">9. Term, suspension, and termination</h2>
        <ul>
          <li>
            These Terms remain in effect for as long as you maintain an account or use the Service.
          </li>
          <li>
            We may suspend or terminate access to the Service (i) for material breach of these Terms
            that is not cured within 30 days of notice, (ii) immediately for conduct that creates
            security, legal, or safety risk, or (iii) for nonpayment, as described in Section 3.
          </li>
          <li>
            A Tenant may terminate its subscription as described in Section 3. Upon termination, we
            will make Tenant Data available for export for 30 days before it is deleted in
            accordance with our data retention practices (see{" "}
            <Link href="/privacy">Privacy Policy</Link>).
          </li>
        </ul>

        <h2 id="disclaimers">10. Disclaimers</h2>
        <p className="legal-caps">
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE.&rdquo; TO THE MAXIMUM
          EXTENT PERMITTED BY LAW, ROUTEFLOW DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING
          WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
          ROUTEFLOW DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE,
          OR THAT ROUTE OPTIMIZATION, DELIVERY ESTIMATES, OR AI-ASSISTED FEATURES (SUCH AS SUPPLIER
          STATEMENT SCANNING) WILL BE ACCURATE; SUCH OUTPUTS SHOULD BE REVIEWED BEFORE BEING RELIED
          UPON FOR BUSINESS OR FINANCIAL DECISIONS.
        </p>

        <h2 id="liability">11. Limitation of liability</h2>
        <p className="legal-caps">
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, ROUTEFLOW AND ITS OFFICERS, EMPLOYEES, AND
          LICENSORS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
          PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING FROM OR
          RELATED TO YOUR USE OF THE SERVICE. EXCEPT FOR (I) A PARTY&rsquo;S BREACH OF SECTION 13
          (CONFIDENTIALITY), (II) A PARTY&rsquo;S INDEMNIFICATION OBLIGATIONS UNDER SECTION 12, OR
          (III) GROSS NEGLIGENCE OR WILLFUL MISCONDUCT, ROUTEFLOW&rsquo;S TOTAL LIABILITY ARISING
          OUT OF OR RELATED TO THESE TERMS WILL NOT EXCEED THE FEES PAID BY THE TENANT IN THE 12
          MONTHS PRECEDING THE CLAIM.
        </p>

        <h2 id="indemnification">12. Indemnification</h2>
        <p>
          The Tenant will indemnify, defend, and hold harmless RouteFlow from any third-party claim
          arising out of Tenant Data or the Tenant&rsquo;s breach of these Terms. RouteFlow will
          indemnify, defend, and hold harmless the Tenant from any third-party claim that the
          Service, as provided by RouteFlow and used in accordance with these Terms, infringes that
          third party&rsquo;s intellectual property rights. Each party&rsquo;s indemnification
          obligation is conditioned on prompt notice, and the indemnifying party controlling the
          defense, of the claim.
        </p>

        <h2 id="confidentiality">13. Confidentiality</h2>
        <p>
          Each party may receive confidential information of the other in connection with the
          Service (including Tenant Data, pricing, and non-public product information). Each party
          agrees to use the other&rsquo;s confidential information only to perform its obligations
          under these Terms and to protect it with reasonable care. These obligations do not apply
          to information that is or becomes public through no fault of the receiving party, was
          already known to the receiving party without a confidentiality obligation, is
          independently developed without use of the disclosing party&rsquo;s confidential
          information, or is required to be disclosed by law (provided the receiving party gives
          notice where legally permitted).
        </p>

        <h2 id="changes-to-service">14. Changes to the Service and these Terms</h2>
        <p>
          We may update these Terms from time to time. If we make material changes, we will update
          the &ldquo;Last updated&rdquo; date above and provide notice (such as an in-app notice or
          email to Tenant account holders) before the change takes effect. Continued use of the
          Service after a change takes effect constitutes acceptance of the updated Terms.
        </p>

        <h2 id="governing-law">15. Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws of the State of Wyoming, USA, without regard to its
          conflict-of-laws principles. Any dispute arising out of or relating to these Terms or the
          Service will be brought exclusively in the state or federal courts located in Wyoming,
          USA, and each party consents to the personal jurisdiction of those courts.
        </p>

        <h2 id="general">16. General</h2>
        <ul>
          <li>
            <strong>Entire agreement.</strong> These Terms, together with any order form, Privacy
            Policy, and (if applicable) Data Processing Addendum, constitute the entire agreement
            between you and RouteFlow regarding the Service.
          </li>
          <li>
            <strong>Assignment.</strong> Neither party may assign these Terms without the
            other&rsquo;s consent, except that RouteFlow may assign these Terms in connection with a
            merger, acquisition, or sale of substantially all of its assets.
          </li>
          <li>
            <strong>Severability.</strong> If any provision of these Terms is found unenforceable,
            the remaining provisions remain in full effect.
          </li>
          <li>
            <strong>No waiver.</strong> Our failure to enforce a provision is not a waiver of our
            right to do so later.
          </li>
        </ul>

        <h2 id="contact">17. Contact us</h2>
        <p>Questions about these Terms:</p>
        <ul>
          <li>
            <strong>Email:</strong> <a href={`mailto:${site.email}`}>{site.email}</a>
          </li>
          <li>
            <strong>Security reports:</strong>{" "}
            <a href="mailto:security@routeflow.info">security@routeflow.info</a>
          </li>
          <li>
            <strong>Mail:</strong> 10701 Corporate Dr Ste 190, Stafford, TX 77477
          </li>
        </ul>

        <Link href="/" className="text-link">
          Return to RouteFlow <ArrowRight size={18} />
        </Link>
      </section>
    </div>
  );
}
