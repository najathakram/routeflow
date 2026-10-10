jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: class InvoicePdfService {},
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import {
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
} from "@nestjs/common/constants";
import { EstimatesModule } from "../estimates/estimates.module";
import { EstimatesService } from "../estimates/estimates.service";
import { InvoicesModule } from "../invoices/invoices.module";
import { InvoicesService } from "../invoices/invoices.service";
import { SellingRestrictionsModule } from "./selling-restrictions.module";
import { SellingRestrictionsService } from "./selling-restrictions.service";

/**
 * F-05 (#2093): every line-writing SERVICE that calls the choke point takes `SellingRestrictionsService`
 * as a REQUIRED constructor dependency (never `@Optional`: a missing provider must be a DI error, not a
 * silent bypass of a ban), and its MODULE imports `SellingRestrictionsModule` (L-113: a DI-scope bug is
 * invisible to tsc and to every hand-built provider list). One row per service as its guard lands; the
 * orders row lives in `orders/orders.module.selling-restrictions.spec.ts`.
 */
describe.each([
  ["InvoicesModule / InvoicesService", InvoicesModule, InvoicesService],
  ["EstimatesModule / EstimatesService", EstimatesModule, EstimatesService],
])("%s ↔ SellingRestrictionsModule wiring", (_name, moduleClass, serviceClass) => {
  it("the module imports SellingRestrictionsModule", () => {
    const imports: unknown[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? [];
    expect(imports).toContain(SellingRestrictionsModule);
  });

  it("the dependency is REQUIRED, never @Optional", () => {
    const params: unknown[] = Reflect.getMetadata(PARAMTYPES_METADATA, serviceClass) ?? [];
    const optional: number[] = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, serviceClass) ?? [];
    expect(params).toContain(SellingRestrictionsService);
    expect(optional).not.toContain(params.indexOf(SellingRestrictionsService));
  });
});
