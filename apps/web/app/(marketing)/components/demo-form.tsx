"use client";

import * as React from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Mail } from "lucide-react";
import { demoEmail, site } from "../lib/site";

// Client-side `mailto:` draft builder — port of the redesign's
// components/demo-form.tsx (M1 §2f/§10). Field labels are "Name / Email /
// Company / Notes" per ux-spec.md §3's Contact page anatomy (spec.md R8). No
// network request is ever made — the copy below discloses that explicitly.

export function DemoForm() {
  const [draft, setDraft] = React.useState("");
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = formData.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    setDraft(
      demoEmail({
        name: field("name"),
        email: field("email"),
        company: field("company"),
        notes: field("notes"),
      }),
    );
    setTimeout(() => headingRef.current?.focus(), 0);
  }

  if (draft) {
    return (
      <div className="demo-form-card">
        <div className="draft-state">
          <span className="draft-icon">
            <Check size={26} />
          </span>
          <h2 tabIndex={-1} ref={headingRef}>
            Your email draft is ready.
          </h2>
          <p>
            Open your email app, review the details, and send the request to {site.email}. Nothing
            has been sent yet.
          </p>
          <a href={draft} className="button">
            <Mail size={18} /> Open email app
          </a>
          <p className="draft-fallback">
            No email app? Contact <a href={`mailto:${site.email}`}>{site.email}</a> with your
            company name and the workflow you want to discuss.
          </p>
          <button type="button" className="text-link" onClick={() => setDraft("")}>
            <ArrowLeft size={16} /> Start a new draft
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="demo-form-card">
      <span className="form-kicker">YOUR WORKFLOW, YOUR WALKTHROUGH</span>
      <h2>Let’s start with your business.</h2>
      <p>Tell us a little about your team.</p>
      <form onSubmit={prepare}>
        <div className="field">
          <label htmlFor="demo-name">Name</label>
          <input
            id="demo-name"
            name="name"
            autoComplete="name"
            required
            maxLength={100}
            placeholder="Alex Morgan"
          />
        </div>
        <div className="field">
          <label htmlFor="demo-email">Email</label>
          <input
            id="demo-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={160}
            placeholder="alex@yourcompany.com"
          />
        </div>
        <div className="field">
          <label htmlFor="demo-company">Company</label>
          <input
            id="demo-company"
            name="company"
            autoComplete="organization"
            required
            maxLength={160}
            placeholder="Your distribution business"
          />
        </div>
        <div className="field">
          <label htmlFor="demo-notes">Notes</label>
          <textarea
            id="demo-notes"
            name="notes"
            maxLength={1200}
            placeholder="Tell us about your orders, delivery routes, or current tools."
            rows={3}
          />
        </div>
        <button className="button" type="submit">
          Prepare my demo request <ArrowRight size={18} />
        </button>
        <p className="form-disclosure">
          This prepares an email for you to review and send. It does not submit or store your
          request.
        </p>
      </form>
    </div>
  );
}
