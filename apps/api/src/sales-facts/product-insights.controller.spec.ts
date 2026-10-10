import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InsightWindowError } from "../analytics/demand-range";
import { ProductInsightsController } from "./product-insights.controller";
import type { ProductInsightsService } from "./product-insights.service";
import { InvalidLineCursorError } from "./sales-facts.rules";

/**
 * #2118 — the controller is thin: map refused windows / forged cursors to 400, pass 404s
 * through, and stream the CSV with backpressure without ever turning a mid-stream failure into
 * a second response.
 */
function fakeResponse() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    destroyed: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
    },
    write(chunk: string) {
      res.body += chunk;
      return true;
    },
    end() {
      res.ended = true;
    },
    once: jest.fn(),
    off: jest.fn(),
  };
  return res;
}

async function* chunks(parts: string[], failAfter?: number) {
  for (const [i, p] of parts.entries()) {
    if (failAfter != null && i === failAfter) throw new Error("db went away");
    yield p;
  }
}

describe("ProductInsightsController (#2118)", () => {
  let service: {
    getProductInsights: jest.Mock;
    getProductSalesPage: jest.Mock;
    prepareCsvExport: jest.Mock;
  };
  let controller: ProductInsightsController;

  beforeEach(() => {
    service = {
      getProductInsights: jest.fn(),
      getProductSalesPage: jest.fn(),
      prepareCsvExport: jest.fn(),
    };
    controller = new ProductInsightsController(service as unknown as ProductInsightsService);
  });

  it("answers 400 for a refused window and a forged cursor; a 404 passes through", async () => {
    service.getProductInsights.mockRejectedValueOnce(new InsightWindowError("too long"));
    await expect(controller.getInsights("p1", {})).rejects.toBeInstanceOf(BadRequestException);

    service.getProductSalesPage.mockRejectedValueOnce(new InvalidLineCursorError());
    await expect(controller.getSales("p1", { cursor: "x" })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    service.getProductInsights.mockRejectedValueOnce(new NotFoundException("Product not found"));
    await expect(controller.getInsights("p1", {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it("passes the query through untouched", async () => {
    service.getProductInsights.mockResolvedValue({ ok: true });
    await controller.getInsights("p1", { from: "2026-01-01", grain: "week" });
    expect(service.getProductInsights).toHaveBeenCalledWith("p1", {
      from: "2026-01-01",
      grain: "week",
    });
  });

  it("streams the CSV as an attachment and ends the response", async () => {
    service.prepareCsvExport.mockResolvedValue({
      filename: "product-sales-SW-12-2026-01-01-to-2026-01-31.csv",
      csv: chunks(["a,b\r\n", "1,2\r\n"]),
    });
    const res = fakeResponse();

    await controller.exportCsv("p1", {}, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="product-sales-SW-12-2026-01-01-to-2026-01-31.csv"',
    );
    expect(res.body).toBe("a,b\r\n1,2\r\n");
    expect(res.ended).toBe(true);
  });

  it("a refused export is a JSON error before any byte is written", async () => {
    service.prepareCsvExport.mockRejectedValue(new InsightWindowError("inverted"));
    const res = fakeResponse();
    await expect(controller.exportCsv("p1", {}, res)).rejects.toBeInstanceOf(BadRequestException);
    expect(res.body).toBe("");
    expect(res.statusCode).toBe(0);
  });

  it("a failure mid-stream marks the file incomplete and ends it — never a second response", async () => {
    service.prepareCsvExport.mockResolvedValue({
      filename: "x.csv",
      csv: chunks(["a,b\r\n", "1,2\r\n"], 1),
    });
    const res = fakeResponse();

    await expect(controller.exportCsv("p1", {}, res)).resolves.toBeUndefined();

    expect(res.body).toBe("a,b\r\n\r\n# export failed: the file is incomplete\r\n");
    expect(res.ended).toBe(true);
  });

  it("stops reading when the client has gone away", async () => {
    const res = fakeResponse();
    const gen = chunks(["a\r\n", "b\r\n", "c\r\n"]);
    service.prepareCsvExport.mockResolvedValue({ filename: "x.csv", csv: gen });
    res.write = (chunk: string) => {
      res.body += chunk;
      res.destroyed = true; // the socket closed after the first chunk
      return true;
    };

    await controller.exportCsv("p1", {}, res);

    expect(res.body).toBe("a\r\n");
  });
});
