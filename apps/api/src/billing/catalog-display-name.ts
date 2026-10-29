/**
 * W-832: the catalog DISPLAY name of a plan or add-on, for the owned Stripe product a revert re-creates (the name
 * shows on invoices, so it must never be the bare plan code). Newest non-draft version wins, so a retired key still
 * resolves. Returns null when the catalog has no such key: the caller fails closed.
 */
import type { PrismaService } from "../prisma/prisma.service";
import type { StripeProductKind } from "./stripe-product";

export type ResolveCatalogName = (kind: StripeProductKind, key: string) => Promise<string | null>;

export function catalogNameResolver(prisma: PrismaService): ResolveCatalogName {
  return async (kind, key) => {
    const planVersion = {
      status: { in: ["PUBLISHED", "SUPERSEDED"] as ("PUBLISHED" | "SUPERSEDED")[] },
    };
    const orderBy = { planVersion: { version: "desc" as const } };
    const row =
      kind === "plan"
        ? await prisma.planDefinition.findFirst({
            where: { planKey: { equals: key, mode: "insensitive" }, planVersion },
            orderBy,
            select: { name: true },
          })
        : await prisma.addonSku.findFirst({
            where: { sku: { equals: key, mode: "insensitive" }, planVersion },
            orderBy,
            select: { name: true },
          });
    const name = row?.name?.trim();
    return name ? name : null;
  };
}
