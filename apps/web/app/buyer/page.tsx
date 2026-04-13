import Link from "next/link";
import {
  ShoppingCart,
  BarChart3,
  FileText,
  ArrowRight,
  CheckCircle2,
  Users,
  Zap,
  Shield,
} from "lucide-react";

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
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-buyer-50 text-buyer-600">
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
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-buyer-600 text-xl font-bold text-white shadow-lg">
        {number}
      </div>
      <h3 className="text-lg font-semibold text-navy mb-2">{title}</h3>
      <p className="text-sm text-navy/60 leading-relaxed">{description}</p>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BuyerLandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="sticky top-0 z-50 border-b border-buyer-800/10 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <img src="/logo-buyer.png" alt="RouteFlow" className="h-8 w-8 object-contain" />
            <span className="text-lg font-bold text-navy">RouteFlow</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/buyer/login"
              className="text-sm font-medium text-navy/70 hover:text-navy transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/buyer/register"
              className="rounded-lg bg-buyer-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-buyer-700"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-buyer-900 via-buyer-800 to-buyer-700 py-24 lg:py-32">
        {/* Decorative elements */}
        <div className="absolute -top-32 -right-32 h-[500px] w-[500px] rounded-full bg-buyer-600/20 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 h-[400px] w-[400px] rounded-full bg-buyer-500/10 blur-3xl" />
        <div className="absolute top-1/2 left-1/3 h-64 w-64 rounded-full bg-buyer-400/5 blur-2xl" />

        <div className="relative z-10 mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-buyer-400/30 bg-buyer-800/50 px-4 py-1.5 text-sm text-buyer-200">
            <Zap className="h-3.5 w-3.5" />
            B2B ordering made effortless
          </div>

          <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Order smarter.{" "}
            <span className="text-buyer-300">Grow faster.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg text-buyer-200/80 leading-relaxed">
            The easiest way to order from your suppliers. Browse personalized catalogs, track every delivery, and manage invoices. All in one place.
          </p>

          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/buyer/register"
              className="flex items-center gap-2 rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-buyer-800 shadow-lg transition-all hover:shadow-xl hover:bg-buyer-50"
            >
              Create Free Account <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/buyer/login"
              className="flex items-center gap-2 rounded-xl border border-buyer-400/30 bg-buyer-800/30 px-8 py-3.5 text-base font-medium text-white transition-colors hover:bg-buyer-700/50"
            >
              Sign In
            </Link>
          </div>

          <div className="mt-12 flex items-center justify-center gap-8 text-buyer-300/80 text-sm">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-buyer-400" />
              Free to use
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-buyer-400" />
              No credit card required
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-buyer-400" />
              Connect in minutes
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 bg-surface-raised">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-navy">Everything you need to order efficiently</h2>
            <p className="mt-3 text-navy/60 max-w-2xl mx-auto">
              RouteFlow gives you the tools to manage your supplier relationships, orders, and invoices in one streamlined platform.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              icon={ShoppingCart}
              title="Browse & Order"
              description="Search products by name or SKU, see your personalized pricing, order in boxes or individual units."
            />
            <FeatureCard
              icon={BarChart3}
              title="Track Everything"
              description="Real-time order status updates, delivery notifications, and complete order history at your fingertips."
            />
            <FeatureCard
              icon={FileText}
              title="Manage Invoices"
              description="View invoices as they arrive, track payments, and download PDFs. All linked to your deliveries."
            />
            <FeatureCard
              icon={Shield}
              title="Secure & Reliable"
              description="Enterprise-grade security with role-based access. Your data is protected and always available."
            />
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section className="py-20 bg-white">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-navy">Get started in 3 simple steps</h2>
          </div>

          <div className="flex flex-col items-center gap-12 sm:flex-row sm:justify-center sm:gap-16">
            <Step
              number={1}
              title="Connect"
              description="Accept an invite from your supplier or request to connect with them."
            />
            <div className="hidden sm:block">
              <ArrowRight className="h-8 w-8 text-buyer-300" />
            </div>
            <Step
              number={2}
              title="Browse"
              description="Explore their catalog with your personalized tier pricing and favorites."
            />
            <div className="hidden sm:block">
              <ArrowRight className="h-8 w-8 text-buyer-300" />
            </div>
            <Step
              number={3}
              title="Order"
              description="Add items to your order, track deliveries, and manage everything in one place."
            />
          </div>
        </div>
      </section>

      {/* Social proof / stats */}
      <section className="py-16 bg-buyer-50">
        <div className="mx-auto max-w-4xl px-6">
          <div className="grid gap-8 sm:grid-cols-3 text-center">
            <div>
              <p className="text-3xl font-bold text-buyer-700">Fast</p>
              <p className="text-sm text-navy/60 mt-1">Place orders in seconds, not minutes</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-buyer-700">Connected</p>
              <p className="text-sm text-navy/60 mt-1">Real-time updates on every order</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-buyer-700">Simple</p>
              <p className="text-sm text-navy/60 mt-1">No training needed. Intuitive design.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-gradient-to-br from-buyer-900 to-buyer-800">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to streamline your ordering?
          </h2>
          <p className="text-buyer-200/80 mb-8">
            Join RouteFlow today and experience the easiest way to manage your B2B purchasing.
          </p>
          <Link
            href="/buyer/register"
            className="inline-flex items-center gap-2 rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-buyer-800 shadow-lg transition-all hover:shadow-xl hover:bg-buyer-50"
          >
            <Users className="h-5 w-5" />
            Create Your Free Account
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface-border bg-white py-8">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo-buyer.png" alt="RouteFlow" className="h-6 w-6 object-contain" />
            <span className="text-sm font-semibold text-navy">RouteFlow</span>
          </div>
          <p className="text-xs text-navy/40">
            &copy; {new Date().getFullYear()} RouteFlow. All rights reserved.
          </p>
          <div className="flex items-center gap-4 text-xs text-navy/50">
            <Link href="/buyer/login" className="hover:text-navy transition-colors">
              Sign In
            </Link>
            <Link href="/buyer/register" className="hover:text-navy transition-colors">
              Register
            </Link>
            <Link href="/login" className="hover:text-navy transition-colors">
              Staff Portal
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
