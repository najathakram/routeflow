"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Scroll-reveal for section headings/cards. Renders nothing; content stays
// fully visible without JavaScript and under prefers-reduced-motion — it
// only ever REMOVES the `.reveal-pending` class that marketing.css's
// `.editorial-reveal` rules key off (ported near-verbatim from the
// redesign's components/editorial-motion.tsx; spec.md R7/R14).
const REVEAL_SELECTOR =
  ".section-heading,.split-heading,.capability-card,.wholesale-extras,.problem-grid article,.audience-card,.buying-confidence,.cta-block,.story-section";

export function EditorialMotion() {
  const pathname = usePathname();

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    const nodes = Array.from(document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          (entry.target as HTMLElement).classList.remove("reveal-pending");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.07, rootMargin: "0px 0px -24px 0px" },
    );

    nodes.forEach((node) => {
      node.classList.add("editorial-reveal");
      if (node.getBoundingClientRect().top > window.innerHeight) {
        node.classList.add("reveal-pending");
        observer.observe(node);
      }
    });

    const revealAll = () => {
      if (reduced.matches) nodes.forEach((node) => node.classList.remove("reveal-pending"));
    };
    reduced.addEventListener("change", revealAll);

    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", revealAll);
      nodes.forEach((node) => node.classList.remove("reveal-pending", "editorial-reveal"));
    };
  }, [pathname]);

  return null;
}
