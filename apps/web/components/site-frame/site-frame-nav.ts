// The header and footer links of the public site, in one place. They are the same links the
// ready-made pages in public/site carry (header, phone menu, footer); site-frame.test.tsx reads
// those files and fails when the two lists differ, so the React pages that wear the same frame
// (Privacy, Terms, sign-in, sign-up, 404) never say a different thing about where things are.

export const NAV_LINKS = [
  { href: "/product", label: "Product" },
  { href: "/#use-cases", label: "Use cases" },
  { href: "/#stores", label: "For stores" },
  { href: "/pricing", label: "Pricing" },
  { href: "/getting-started", label: "Getting started" },
  { href: "/company", label: "Company" },
] as const;

export const MENU_LINKS = [
  ...NAV_LINKS.slice(0, 5),
  { href: "/does-and-doesnt", label: "What it does and doesn’t do" },
  { href: "/data-in-and-out", label: "Data in and out" },
  { href: "/security", label: "Security and your data" },
  { href: "/company", label: "Company" },
  { href: "/#faq", label: "Questions" },
] as const;

export const FOOTER_COLUMNS = [
  {
    title: "Explore",
    links: [
      ...NAV_LINKS.slice(0, 5),
      { href: "/does-and-doesnt", label: "What it does and doesn’t do" },
      { href: "/data-in-and-out", label: "Data in and out" },
      { href: "/security", label: "Security and your data" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/company", label: "About us" },
      { href: "/#faq", label: "Questions" },
      { href: "/contact", label: "Contact" },
    ],
  },
] as const;

export const SITE_EMAIL = "hello@routeflow.info";
