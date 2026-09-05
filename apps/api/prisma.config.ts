import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  earlyAccess: true as any,
  // Multi-file schema (item 10a): every *.prisma under this folder is one datamodel.
  // Split/verified by `node scripts/split-prisma-schema.mjs --check`.
  schema: path.join("prisma", "schema"),
  migrations: {
    // Explicit now that `schema` is a folder — Prisma's default migrations path is
    // derived from the schema location, and leaving it implicit is how a folder split
    // silently relocates the migration history.
    path: path.join("prisma", "migrations"),
    seed: "npx tsx ./prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
