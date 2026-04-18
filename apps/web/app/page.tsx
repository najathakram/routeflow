import Link from "next/link";
import {
  Truck,
  ClipboardList,
  Receipt,
  ArrowRight,
  CheckCircle2,
  Users,
  Zap,
  Route,
} from "lucide-react";
import { ProductVideo } from "./(marketing)/product-video";
import { InstallAppButton } from "@/components/InstallAppButton";

// ─── Feature Card ────────────────────────────────────────────────────────────

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-surface-border bg-white p-6 shadow-card hover:shadow-dropdown transition-shadow">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="text-lg font-semibold text-navy mb-2">{title}</h3>
      <p className="text-sm text-navy/60 leading-relaxed">{description}</p>
    </div>
  );
}

// ─── Step ────────────────────────────────────────────────────────────────────

function Step({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center text-center max-w-xs">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-xl font-bold text-white shadow-lg">
        {number}
      </div>
      <h3 className="text-lg font-semibold text-navy mb-2">{title}</h3>
      <p className="text-sm text-navy/60 leading-relaxed">{description}</p>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SellerLandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="sticky top-0 z-50 border-b border-navy/5 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="RouteFlow" className="h-8 w-8 object-contain" />
            <span className="text-lg font-bold text-navy">RouteFlow</span>
          </div>
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

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-[#0f1b2d] via-[#152238] to-[#1a2d4a] min-h-screen flex flex-col justify-center py-16">
        {/* Decorative elements */}
        <div className="absolute -top-32 -right-32 h-[500px] w-[500px] rounded-full bg-brand-600/15 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 h-[400px] w-[400px] rounded-full bg-brand-500/10 blur-3xl" />
        <div className="absolute top-1/2 left-1/3 h-64 w-64 rounded-full bg-brand-400/5 blur-2xl" />

        <div className="relative z-10 mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-400/20 bg-white/5 px-4 py-1.5 text-sm text-blue-200">
            <Zap className="h-3.5 w-3.5" />
            Built for wholesale distributors and jobbers
          </div>

          <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Deliver smarter.{" "}
            <span className="text-brand-400">Scale faster.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg text-blue-200/80 leading-relaxed">
            RouteFlow brings your orders, routes, drivers, invoices, and customers
            into one place. Less chasing, less guessing, more delivering.
          </p>

          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/signup"
              className="flex items-center gap-2 rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-navy shadow-lg transition-all hover:shadow-xl hover:bg-brand-50"
            >
              Get Started <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/buyer"
              className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-8 py-3.5 text-base font-medium text-white transition-colors hover:bg-white/10"
            >
              I&apos;m a Buyer
            </Link>
          </div>

          <div className="mt-6">
            <InstallAppButton
              variant="tenant"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12" y2="18" />
              </svg>
              Get the mobile app
            </InstallAppButton>
          </div>

          <div className="mt-12 flex items-center justify-center gap-8 text-blue-300/70 text-sm">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-brand-400" />
              Free 14-day trial
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-brand-400" />
              No setup fees
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-brand-400" />
              Cancel anytime
            </div>
          </div>
        </div>
      </section>

      {/* Scroll-driven product tour — full screen, sticky */}
      <ProductVideo />

      {/* Features */}
      <section className="py-20 bg-surface-raised">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-navy">
              Everything you need, in one place
            </h2>
            <p className="mt-3 text-navy/60 max-w-2xl mx-auto">
              From taking an order to getting paid, RouteFlow handles the whole
              cycle so your team can focus on what matters.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              icon={ClipboardList}
              title="Order Management"
              description="Receive and manage orders from all your customers. Confirm, pick, pack, and dispatch from one place."
            />
            <FeatureCard
              icon={Route}
              title="Route Planning"
              description="Build optimized delivery routes, assign drivers, and track every stop in real time."
            />
            <FeatureCard
              icon={Receipt}
              title="Smart Invoicing"
              description="Invoices generate automatically when a delivery is signed off. Send by email, track payments, and manage credit notes."
            />
            <FeatureCard
              icon={Truck}
              title="Delivery Tracking"
              description="Live driver tracking, proof of delivery, and automatic customer notifications on every run."
            />
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section className="py-20 bg-white">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-navy">
              Up and running in 3 steps
            </h2>
          </div>

          <div className="flex flex-col items-center gap-12 sm:flex-row sm:justify-center sm:gap-16">
            <Step
              number={1}
              title="Set Up"
              description="Add your products, pricing tiers, and invite your customers to their buyer portal."
            />
            <div className="hidden sm:block">
              <ArrowRight className="h-8 w-8 text-brand-300" />
            </div>
            <Step
              number={2}
              title="Manage"
              description="Receive orders, build delivery routes, assign drivers, and confirm dispatches."
            />
            <div className="hidden sm:block">
              <ArrowRight className="h-8 w-8 text-brand-300" />
            </div>
            <Step
              number={3}
              title="Deliver"
              description="Track runs in real time, capture proof of delivery, and invoices take care of themselves."
            />
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-16 bg-brand-50">
        <div className="mx-auto max-w-4xl px-6">
          <div className="grid gap-8 sm:grid-cols-3 text-center">
            <div>
              <p className="text-3xl font-bold text-brand-700">Efficient</p>
              <p className="text-sm text-navy/60 mt-1">
                Optimized routes save your drivers hours every week
              </p>
            </div>
            <div>
              <p className="text-3xl font-bold text-brand-700">Connected</p>
              <p className="text-sm text-navy/60 mt-1">
                Customers order from their own portal, any time
              </p>
            </div>
            <div>
              <p className="text-3xl font-bold text-brand-700">Scalable</p>
              <p className="text-sm text-navy/60 mt-1">
                From 10 customers to 10,000. RouteFlow grows with you.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-gradient-to-br from-[#0f1b2d] to-[#152238]">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to run your rounds like the best in the business?
          </h2>
          <p className="text-blue-200/80 mb-8">
            Start a free 14-day trial today. No credit card, no setup fees.
            Bring your data and you can be live in a day.
          </p>
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-navy shadow-lg transition-all hover:shadow-xl hover:bg-brand-50"
            >
              <Users className="h-5 w-5" />
              Start Free Trial
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/5 px-8 py-3.5 text-base font-medium text-white transition-colors hover:bg-white/10"
            >
              Book a Demo
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface-border bg-white py-8">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/logo.svg"
              alt="RouteFlow"
              className="h-6 w-6 object-contain"
            />
            <span className="text-sm font-semibold text-navy">RouteFlow</span>
          </div>
          <p className="text-xs text-navy/40">
            &copy; {new Date().getFullYear()} RouteFlow. All rights reserved.
          </p>
          <div className="flex items-center gap-4 text-xs text-navy/50">
            <Link href="/login" className="hover:text-navy transition-colors">
              Sign In
            </Link>
            <Link href="/buyer" className="hover:text-navy transition-colors">
              Buyer Portal
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
