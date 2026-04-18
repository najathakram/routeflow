import Link from "next/link";
import { ArrowLeft, Mail, MessageSquare } from "lucide-react";

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="sticky top-0 z-50 border-b border-navy/5 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="RouteFlow" className="h-8 w-8 object-contain" />
            <span className="text-lg font-bold text-navy">RouteFlow</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm font-medium text-navy/70 hover:text-navy transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-6 py-24">
        <Link
          href="/"
          className="mb-10 inline-flex items-center gap-2 text-sm text-navy/50 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </Link>

        <h1 className="text-4xl font-extrabold text-navy mb-4">Book a Demo</h1>
        <p className="text-navy/60 text-lg leading-relaxed mb-10">
          See RouteFlow in action with a personalised walkthrough. We will show you how it fits
          your operation and answer any questions you have.
        </p>

        <form className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-navy mb-1.5">First name</label>
              <input
                type="text"
                className="w-full rounded-lg border border-surface-border px-4 py-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                placeholder="Jane"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-navy mb-1.5">Last name</label>
              <input
                type="text"
                className="w-full rounded-lg border border-surface-border px-4 py-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                placeholder="Smith"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-navy mb-1.5">Work email</label>
            <input
              type="email"
              className="w-full rounded-lg border border-surface-border px-4 py-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              placeholder="jane@yourbusiness.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-navy mb-1.5">Company name</label>
            <input
              type="text"
              className="w-full rounded-lg border border-surface-border px-4 py-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              placeholder="Your Wholesale Co."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-navy mb-1.5">
              How many drivers do you have?
            </label>
            <select className="w-full rounded-lg border border-surface-border px-4 py-2.5 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20">
              <option value="">Select...</option>
              <option>1 to 3</option>
              <option>4 to 10</option>
              <option>11 to 25</option>
              <option>More than 25</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-navy mb-1.5">
              Anything specific you want to cover? (optional)
            </label>
            <textarea
              rows={4}
              className="w-full rounded-lg border border-surface-border px-4 py-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
              placeholder="Invoicing, route planning, driver tracking..."
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-xl bg-brand-600 px-8 py-3.5 text-base font-semibold text-white shadow-lg transition-all hover:bg-brand-700 hover:shadow-xl"
          >
            Request a Demo
          </button>
        </form>

        <div className="mt-12 flex flex-col gap-4 sm:flex-row sm:gap-8 text-sm text-navy/50">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            <span>hello@routeflow.app</span>
          </div>
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            <span>We usually reply within one business day</span>
          </div>
        </div>
      </div>
    </div>
  );
}
