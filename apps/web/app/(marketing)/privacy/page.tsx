import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { routes, site } from "../lib/site";
import { Eyebrow } from "../components/marketing";

// Published privacy policy (R9 follow-up). Source draft:
// local-assets/handoff/2026-09-17/legal/privacy-policy-DRAFT.md — this page carries the
// full text, not the interim shell. `LAST_UPDATED` also feeds the visible "Last updated"
// line below; bump both together when the policy changes.
const LAST_UPDATED = "September 17, 2026";

const route = routes.find((r) => r.slug === "privacy")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/privacy",
    siteName: site.name,
    type: "website",
  },
};

export default function PrivacyPage() {
  return (
    <div className="glass-page">
      <section className="legal-page wrap">
        <Eyebrow>ROUTEFLOW</Eyebrow>
        <h1>Privacy Policy</h1>
        <p>
          <strong>Effective date:</strong> {LAST_UPDATED}
          <br />
          <strong>Last updated:</strong> {LAST_UPDATED}
        </p>

        <p>
          RouteFlow (&ldquo;RouteFlow,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
          &ldquo;our&rdquo;) operates the RouteFlow platform — a multi-tenant software-as-a-service
          application for wholesale distributors that manages orders, delivery routes, invoices,
          payments, a buyer portal, and driver/operator mobile apps (collectively, the
          &ldquo;Service&rdquo;). This Privacy Policy explains what personal information we collect,
          how we use it, who we share it with, and the choices available to you.
        </p>
        <p>
          This policy applies to the RouteFlow marketing website (routeflow.info), the RouteFlow web
          dashboard and buyer portal, and the RouteFlow mobile app for drivers and operators.
        </p>
        <p>
          If you are a customer, driver, or other end user of a business that uses RouteFlow (a
          &ldquo;Tenant&rdquo;), please also see{" "}
          <a href="#controller-vs-processor">&ldquo;Our role: controller vs. processor&rdquo;</a>{" "}
          below — in most cases the Tenant, not RouteFlow, controls how your information is used,
          and you should direct privacy requests to them first.
        </p>

        <h2 id="who-we-are">Who we are</h2>
        <p>
          <strong>Operator:</strong> Routeflow Solutions LLC, a Wyoming limited liability company
          (&ldquo;RouteFlow&rdquo;), 10701 Corporate Dr Ste 190, Stafford, TX 77477
          <br />
          <strong>General contact:</strong> <a href={`mailto:${site.email}`}>{site.email}</a>
          <br />
          <strong>Security / vulnerability reports:</strong>{" "}
          <a href="mailto:security@routeflow.info">security@routeflow.info</a>
          <br />
          <strong>Website:</strong> <a href={site.origin}>{site.origin}</a>
        </p>

        <h2 id="controller-vs-processor">Our role: controller vs. processor</h2>
        <p>
          RouteFlow is a <strong>B2B platform</strong>. Businesses (&ldquo;Tenants&rdquo;) sign up
          for RouteFlow to run their own distribution operations, and their staff invite or add
          their own customers (buyers) and drivers into the system.
        </p>
        <p>
          <strong>Where RouteFlow is a processor.</strong> For data that Tenants put into the
          Service about their own customers, buyers, drivers, orders, invoices, and deliveries, the{" "}
          <strong>Tenant is the data controller</strong> and RouteFlow acts only as a{" "}
          <strong>data processor</strong> (or &ldquo;service provider&rdquo;), processing that data
          solely to provide the Service under our agreement with the Tenant. If you are a customer,
          buyer, or driver of a RouteFlow Tenant and have a question or request about your personal
          data, please contact that business directly; we will assist them in responding as required
          by applicable law.
        </p>
        <p>
          <strong>Where RouteFlow is a controller.</strong> For data about the Tenant&rsquo;s own
          account — account holders, billing contacts, staff user accounts, subscription and payment
          records, support communications, and marketing-site visitors —{" "}
          <strong>RouteFlow is the data controller</strong> and this policy describes our own
          practices directly.
        </p>

        <h2 id="information-we-collect">Information we collect</h2>

        <h3>Information Tenants and their users provide</h3>
        <ul>
          <li>
            <strong>Account &amp; staff data:</strong> name, email, phone, role, password (hashed),
            tenant/company name.
          </li>
          <li>
            <strong>Customer (buyer) records:</strong> business name, contact name, email, phone,
            delivery address, order history, pricing tier, and communications entered by the Tenant
            or by the buyer through the buyer portal.
          </li>
          <li>
            <strong>Driver data:</strong> name, contact info, assigned routes/vehicles, and — while
            an active delivery route is in progress — real-time and route-history{" "}
            <strong>location data</strong> (see &ldquo;Location data&rdquo; below).
          </li>
          <li>
            <strong>Order, route, and delivery data:</strong> orders, line items, delivery stops,
            route sequencing, proof-of-delivery (POD) photos, signatures, and delivery notes.
          </li>
          <li>
            <strong>Financial data:</strong> invoices, credit notes, vendor bills, payment records
            (including post-dated check details where a Tenant uses that feature), and billing
            history. Card payments are processed by <strong>Stripe</strong>; RouteFlow does not
            store full card numbers.
          </li>
          <li>
            <strong>Uploaded files:</strong> product images, receipts, supplier statements/invoices,
            and other documents Tenants upload to the Service.
          </li>
          <li>
            <strong>Support &amp; communications:</strong> messages sent to{" "}
            <a href={`mailto:${site.email}`}>{site.email}</a> or{" "}
            <a href="mailto:security@routeflow.info">security@routeflow.info</a>, or through in-app
            support/notification features.
          </li>
          <li>
            <strong>Demo booking requests:</strong> if you book a product walkthrough on
            routeflow.info, we collect your name, email, company, optional phone number and notes,
            your selected meeting time and time zone, and your IP address. See{" "}
            <a href="#demo-booking">&ldquo;Demo booking requests&rdquo;</a> below for how this is
            stored and scheduled.
          </li>
        </ul>

        <h3>Information collected automatically</h3>
        <ul>
          <li>
            <strong>Usage &amp; device data:</strong> IP address, browser/device type, pages viewed,
            and actions taken in the web dashboard and mobile app, collected for security,
            debugging, and service-reliability purposes.
          </li>
          <li>
            <strong>Cookies (web):</strong> RouteFlow&rsquo;s web app uses a small number of{" "}
            <strong>strictly necessary</strong> cookies to keep you signed in and route you to the
            correct portal (e.g., an authentication-presence cookie and a &ldquo;last portal
            used&rdquo; cookie). These cookies do not track you across other websites. We do not
            currently use third-party advertising or analytics cookies.
          </li>
          <li>
            <strong>Location data (mobile, drivers only):</strong> while a driver is actively
            running a delivery route, the RouteFlow mobile app collects device location — including
            in the background while the route is in progress — so dispatch/operators can see live
            route progress, sequence stops, and confirm deliveries. Location is not collected
            outside of an active route, and is not collected from customer/buyer or operator
            (non-driver) accounts. Drivers can disable location sharing in their device settings,
            which will prevent live tracking from functioning.
          </li>
          <li>
            <strong>Camera &amp; photos (mobile):</strong> the mobile app requests camera access to
            scan product barcodes and to photograph receipts, supplier bills, product images, and
            proof-of-delivery. It requests photo-library access so users can attach existing photos
            (e.g., receipts) instead of taking a new one. Camera/photo access is used only for these
            in-app features; RouteFlow does not access your device&rsquo;s photo library or camera
            outside of an explicit in-app action.
          </li>
        </ul>

        <h3>Information from third parties</h3>
        <ul>
          <li>
            <strong>Google Sign-In:</strong> if you sign in with Google, we receive your name, email
            address, and Google account ID from Google to create or authenticate your RouteFlow
            account.
          </li>
          <li>
            <strong>Optional CRM sync (per-Tenant):</strong> a Tenant may connect a third-party CRM
            — currently <strong>GoHighLevel</strong> — to sync contact and opportunity records
            (name, email, phone, tags, notes, deal/opportunity status) between that CRM and
            RouteFlow. This is off by default and controlled entirely by the Tenant.
          </li>
          <li>
            <strong>Optional data import (per-Tenant):</strong> a Tenant may import historical
            business data from a source system (for example, <strong>Zoho CRM</strong>) when
            onboarding onto RouteFlow.
          </li>
        </ul>

        <h2 id="how-we-use-information">How we use information</h2>
        <p>We use the information described above to:</p>
        <ul>
          <li>
            provide, operate, and maintain the Service (accounts, orders, routing, invoicing,
            payments, notifications);
          </li>
          <li>authenticate users and secure accounts;</li>
          <li>
            optimize delivery routes (delivery stop addresses/coordinates are sent to our routing
            engine — see <a href="#sub-processors">&ldquo;Sub-processors&rdquo;</a> — solely to
            compute route sequencing and ETAs);
          </li>
          <li>process payments and manage subscriptions and billing;</li>
          <li>
            send transactional communications (order confirmations, invoices, password resets, route
            notifications);
          </li>
          <li>
            provide customer support and respond to inquiries sent to{" "}
            <a href={`mailto:${site.email}`}>{site.email}</a> or{" "}
            <a href="mailto:security@routeflow.info">security@routeflow.info</a>;
          </li>
          <li>detect, investigate, and prevent fraud, abuse, and security incidents;</li>
          <li>comply with legal obligations (e.g., tax and accounting records); and</li>
          <li>improve the reliability and performance of the Service.</li>
        </ul>
        <p>
          We do <strong>not</strong> sell personal information, and we do not use Tenant, customer,
          or driver data to serve third-party advertising.
        </p>

        <h2 id="sub-processors">Sub-processors and service providers</h2>
        <p>
          We share information with the following categories of service providers, each of which
          processes data on our behalf and only as needed to provide the Service. This list reflects
          what the RouteFlow codebase and infrastructure actually use as of this document&rsquo;s
          last-updated date above.
        </p>
        <div className="legal-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Purpose</th>
                <th>Data involved</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Railway (United States)</td>
                <td>Application hosting, PostgreSQL database, Redis cache</td>
                <td>All Service data described above</td>
              </tr>
              <tr>
                <td>Stripe</td>
                <td>Subscription billing and payment processing</td>
                <td>
                  Billing contact info, subscription/plan data, payment tokens (not full card
                  numbers)
                </td>
              </tr>
              <tr>
                <td>Google</td>
                <td>
                  Sign-In authentication; Google Maps (route/map display); Firebase Cloud Messaging
                  (push notifications); Google Calendar (internal scheduling of demo-booking
                  meetings, via a RouteFlow-owned service account)
                </td>
                <td>
                  Name/email/account ID (Sign-In); delivery addresses/coordinates (Maps); device
                  push token (FCM); demo-booking contact details placed on RouteFlow&rsquo;s
                  internal calendar event
                </td>
              </tr>
              <tr>
                <td>Google Workspace (primary)</td>
                <td>
                  RouteFlow&rsquo;s primary platform transactional email delivery (order
                  confirmations, invoices, password resets, demo-booking confirmations, etc.), sent
                  through RouteFlow&rsquo;s own Google Workspace mailbox via SMTP; also hosts
                  RouteFlow&rsquo;s own business inboxes
                </td>
                <td>
                  Recipient email address, email content, and the contents of messages sent to our
                  business inboxes
                </td>
              </tr>
              <tr>
                <td>Resend (fallback)</td>
                <td>
                  Fallback platform transactional email delivery, used automatically only when
                  RouteFlow&rsquo;s Google Workspace SMTP is not configured
                </td>
                <td>Recipient email address and email content</td>
              </tr>
              <tr>
                <td>OpenRouteService (ORS)</td>
                <td>Route optimization engine</td>
                <td>
                  Delivery stop addresses/coordinates, sent solely to compute optimized route
                  sequencing
                </td>
              </tr>
              <tr>
                <td>Cloudflare R2 / Railway volume storage</td>
                <td>File storage for uploaded documents and images</td>
                <td>Product images, receipts, supplier statements, proof-of-delivery photos</td>
              </tr>
              <tr>
                <td>Anthropic (Claude API)</td>
                <td>
                  Optional AI-assisted scanning of supplier statements/invoices, when a Tenant
                  enables this feature
                </td>
                <td>Uploaded supplier statement/document images and extracted line-item data</td>
              </tr>
              <tr>
                <td>GoHighLevel</td>
                <td>Optional per-Tenant CRM sync (off by default)</td>
                <td>Contact/opportunity name, email, phone, tags, notes</td>
              </tr>
              <tr>
                <td>Zoho CRM</td>
                <td>Optional per-Tenant data import source during onboarding</td>
                <td>Historical business records imported by the Tenant</td>
              </tr>
              <tr>
                <td>Sentry</td>
                <td>Optional error monitoring, when configured</td>
                <td>
                  Technical error/crash data; may incidentally include portions of application state
                  at time of error
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          We may add or change sub-processors as the Service evolves; material changes will be
          reflected in an updated version of this policy.
        </p>

        <h3 id="connect-mailbox">
          Coming soon: connecting your own email account (&ldquo;Connect Gmail/Outlook&rdquo;)
        </h3>
        <p>
          RouteFlow is building an optional feature that lets a Tenant admin connect their own Gmail
          or Microsoft 365/Outlook mailbox so that customer-facing emails (like invoices and order
          notifications) are sent <strong>from the Tenant&rsquo;s own address</strong> instead of
          RouteFlow&rsquo;s. When this feature is live and a Tenant chooses to use it:
        </p>
        <ul>
          <li>
            RouteFlow requests only a <strong>send-only</strong> permission — Google&rsquo;s{" "}
            <code>gmail.send</code> scope or Microsoft Graph&rsquo;s <code>Mail.Send</code>{" "}
            permission.{" "}
            <strong>
              RouteFlow cannot read, search, or otherwise access the contents of your mailbox,
              inbox, or any other email in your account.
            </strong>
          </li>
          <li>
            RouteFlow uses this permission only to send the specific transactional emails the
            Tenant&rsquo;s business generates through RouteFlow (e.g., invoices, order
            confirmations).
          </li>
          <li>
            The connection&rsquo;s access/refresh tokens are stored{" "}
            <strong>encrypted at rest</strong> and are never logged or displayed after the initial
            connection.
          </li>
          <li>
            <strong>Disconnecting</strong> the mailbox immediately and permanently deletes the
            stored tokens from RouteFlow&rsquo;s systems.
          </li>
        </ul>

        <h3>Google API Services User Data Policy — Limited Use disclosure</h3>
        <p>
          RouteFlow&rsquo;s use and transfer to any other app of information received from Google
          APIs will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the <strong>Limited Use requirements</strong>. In substance, this means
          RouteFlow:
        </p>
        <ul>
          <li>
            limits its use of data obtained through Google API scopes to providing or improving the
            user-facing features described above;
          </li>
          <li>
            does not transfer that data to third parties except as needed to provide or improve
            those features (with consent), for security purposes, to comply with law, or as part of
            a merger/acquisition (with notice);
          </li>
          <li>
            does not allow humans to read that data except with explicit user consent, for security
            purposes, to comply with law, or on an aggregated and anonymized basis for internal
            operations; and
          </li>
          <li>
            does not use that data to serve advertisements (including retargeting or interest-based
            advertising), and does not use it to determine creditworthiness or for lending purposes.
          </li>
        </ul>

        <h3 id="demo-booking">Demo booking requests (marketing site)</h3>
        <p>
          The &ldquo;Request a demo&rdquo; scheduler on routeflow.info lets a visitor book a
          walkthrough meeting directly. When you submit a booking, we collect and{" "}
          <strong>store in RouteFlow&rsquo;s own database</strong>: your name, email address,
          company name, phone number (optional), notes on what you&rsquo;d like covered (optional),
          your selected date/time and time zone, the marketing page you booked from, and your IP
          address (used to prevent abuse of the booking system).
        </p>
        <p>
          To schedule the meeting internally, RouteFlow creates an event on{" "}
          <strong>RouteFlow&rsquo;s own Google Calendar</strong> (via a RouteFlow-owned service
          account, not your Google account), containing your name, company, contact email/phone, and
          notes so our team can prepare.{" "}
          <strong>Your email address is not added as a Google Calendar attendee/invitee</strong> —
          Google does not send you a calendar invite, and no Google account of yours is involved.
          Your booking confirmation, and any reschedule/cancellation link, is emailed to you
          directly by RouteFlow.
        </p>
        <p>
          The confirmation email contains a link that lets you reschedule or cancel your own
          booking; RouteFlow stores only a one-way cryptographic hash of that link&rsquo;s token,
          not the token itself, so the token cannot be recovered from our database.
        </p>
        <p>
          Demo booking records are retained for 12 months unless you become a RouteFlow Tenant, in
          which case ordinary account data retention applies (see &ldquo;Data retention&rdquo;
          below).
        </p>

        <h2 id="data-retention">Data retention</h2>
        <ul>
          <li>
            We retain Tenant account and operational data (orders, invoices, routes, uploaded
            documents, etc.) for as long as the Tenant&rsquo;s subscription is active, plus 30 days
            to allow account recovery, and as needed to satisfy tax, accounting, and legal
            recordkeeping obligations.
          </li>
          <li>
            Driver location data collected during a delivery route is retained for 90 days and used
            only for route history and delivery confirmation.
          </li>
          <li>
            We retain marketing-site inquiries and support communications for up to 24 months.
          </li>
          <li>
            We delete or anonymize personal information when it is no longer needed for the purposes
            described in this policy, or sooner upon a valid deletion request (see{" "}
            <a href="#your-rights">&ldquo;Your rights and choices&rdquo;</a> below).
          </li>
        </ul>

        <h2 id="your-rights">Your rights and choices</h2>
        <p>
          Depending on your location and relationship to RouteFlow, you may have rights to access,
          correct, export, or delete your personal information, and to object to or restrict certain
          processing.
        </p>
        <ul>
          <li>
            <strong>If you are a customer, buyer, or driver of a Tenant:</strong> please contact
            that business directly — they control your data and are best positioned to fulfill your
            request. We will support them in doing so.
          </li>
          <li>
            <strong>
              If you are a Tenant account holder, staff user, or website visitor contacting
              RouteFlow directly:
            </strong>{" "}
            email <a href={`mailto:${site.email}`}>{site.email}</a> with your request. We will
            respond within 30 days and may need to verify your identity before acting on the
            request.
          </li>
          <li>
            You can also access and update most of your account information directly within the
            RouteFlow web dashboard, buyer portal, or mobile app settings.
          </li>
        </ul>
        <p>
          If you are located in the European Economic Area, the United Kingdom, Switzerland,
          California, or another jurisdiction with its own data-protection law, you may have
          additional rights under that law — for example, the right to lodge a complaint with your
          local data protection authority, or California&rsquo;s right to know, delete, or opt out
          of the sale or sharing of personal information. As noted above, RouteFlow does not sell
          personal information. To exercise any of these rights, contact{" "}
          <a href={`mailto:${site.email}`}>{site.email}</a>.
        </p>

        <h2 id="data-security">Data security</h2>
        <p>
          We use industry-standard safeguards to protect information, including encryption of
          sensitive data at rest (e.g., stored third-party credentials and connected-mailbox
          tokens), encrypted connections (TLS) in transit, and access controls scoped per Tenant. No
          method of transmission or storage is 100% secure. If you discover a potential security
          vulnerability, please report it to{" "}
          <a href="mailto:security@routeflow.info">security@routeflow.info</a> — see our{" "}
          <a
            href="https://github.com/najathakram/routeflow/blob/master/SECURITY.md"
            target="_blank"
            rel="noreferrer"
          >
            Security Policy
          </a>{" "}
          for our responsible-disclosure process.
        </p>

        <h2 id="international-transfers">International data transfers</h2>
        <p>
          RouteFlow&rsquo;s infrastructure is hosted in the United States (via Railway). If you
          access the Service from outside the United States, your information will be transferred to
          and processed in the United States. Where required, we rely on the European
          Commission&rsquo;s Standard Contractual Clauses (or an equivalent lawful transfer
          mechanism) to safeguard personal information transferred from the EEA, UK, or Switzerland
          to the United States.
        </p>

        <h2 id="childrens-privacy">Children&rsquo;s privacy</h2>
        <p>
          The Service is a business tool intended for use by adults acting on behalf of a business.
          RouteFlow is not directed to children, and we do not knowingly collect personal
          information from anyone under the age of 18. If you believe a child has provided us with
          personal information, please contact <a href={`mailto:${site.email}`}>{site.email}</a> so
          we can delete it.
        </p>

        <h2 id="changes">Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. If we make material changes, we will
          update the &ldquo;Last updated&rdquo; date above and, where appropriate, provide
          additional notice (such as an in-app notice or email to Tenant account holders). Your
          continued use of the Service after a change takes effect constitutes acceptance of the
          updated policy.
        </p>

        <h2 id="governing-law">Governing law</h2>
        <p>
          This Privacy Policy is governed by the laws of the State of Wyoming, USA, without regard
          to its conflict-of-laws principles. Any dispute arising out of or relating to this Privacy
          Policy will be brought exclusively in the state or federal courts located in Wyoming, USA,
          and you consent to the personal jurisdiction of those courts.
        </p>

        <h2 id="contact">Contact us</h2>
        <p>Questions about this Privacy Policy or our data practices:</p>
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
