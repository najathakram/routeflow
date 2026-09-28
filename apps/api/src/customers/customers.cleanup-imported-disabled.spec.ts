import { ConflictException } from "@nestjs/common";
import { CustomersService } from "./customers.service";

/**
 * #2629 (owner policy 4c, SA-531): "Cleanup imported customers" selects customers by a heuristic,
 * not a persisted import marker, so it can reach customers that were never imported. Both entry
 * points are disabled until a real marker exists: a 409 CLEANUP_IMPORTED_DISABLED as the FIRST
 * statement — no Prisma call of any kind, so no row is read or touched.
 */
describe("CustomersService — cleanup-imported is disabled (#2629)", () => {
  const build = () => {
    const touched: string[] = [];
    const prisma = new Proxy(
      {},
      {
        get(_t, prop) {
          touched.push(String(prop));
          return () => {
            throw new Error(`prisma.${String(prop)} must not be called`);
          };
        },
      },
    );
    const svc: any = Object.assign(Object.create(CustomersService.prototype), { prisma });
    return { svc, touched };
  };

  it.each(["previewImportedCleanup", "deleteImportedCustomers"])(
    "%s: 409 CLEANUP_IMPORTED_DISABLED before any Prisma call",
    async (method) => {
      const { svc, touched } = build();
      const err = await svc[method]().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: "CLEANUP_IMPORTED_DISABLED",
      });
      expect(touched).toEqual([]);
    },
  );

  it("no controller reaches the kept bodies (runImportedCleanupPreview / runImportedCustomersCleanup)", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dir = path.join(__dirname, "..");
    const controllers: string[] = [];
    const walk = (d: string) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".controller.ts")) controllers.push(p);
      });
    walk(dir);
    expect(controllers.length).toBeGreaterThan(10);
    const offenders = controllers.filter((f) =>
      /runImportedCleanupPreview|runImportedCustomersCleanup/.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
