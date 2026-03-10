import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  earlyAccess: true as any,
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
