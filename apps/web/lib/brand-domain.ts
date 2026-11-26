import { BRAND } from "@routeflow/types/brand";

/** The brand's host as a person says it: the origin's host without "www." (the legal pages name it). */
export const BRAND_DOMAIN = new URL(BRAND.origin).hostname.replace(/^www\./, "");
