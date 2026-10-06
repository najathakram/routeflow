import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { BatchShipActions } from "./BatchShipActions";
import { BATCH_SHIP_COPY, shippedOrderIds } from "@/lib/batch-ship-copy";
import { BATCH_SHIP_OUTCOMES } from "@routeflow/types";

const batchMutateAsync = jest.fn();
const slipsMutateAsync = jest.fn();
const printPdfBlob = jest.fn();
let methods: string[] | undefined = ["ROUTE", "SHIP"];

jest.mock("@/lib/api/orders", () => ({
  useBatchShipOrders: () => ({ mutateAsync: batchMutateAsync, isPending: false }),
  usePackingSlips: () => ({ mutateAsync: slipsMutateAsync, isPending: false }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: methods ? { capabilities: { fulfilment: { methods } } } : undefined,
  }),
}));
jest.mock("@/lib/print-pdf-blob", () => ({ printPdfBlob: (b: Blob) => printPdfBlob(b) }));

const orders = [
  { id: "o1", orderNumber: "SO-1", customerName: "Acme" },
  { id: "o2", orderNumber: "SO-2", customerName: "Beta" },
  { id: "o3", orderNumber: "SO-3" },
];

function setup() {
  const onDone = jest.fn();
  renderWithProviders(<BatchShipActions orders={orders} onDone={onDone} />);
  return { onDone };
}

beforeEach(() => {
  jest.clearAllMocks();
  methods = ["ROUTE", "SHIP"];
});

describe("BatchShipActions", () => {
  it("is not offered when the tenant's fulfilment methods exclude SHIP (or are unknown)", () => {
    methods = ["ROUTE"];
    setup();
    expect(screen.queryByTestId("batch-ship-open")).toBeNull();
    expect(screen.queryByTestId("batch-ship-slips-open")).toBeNull();
  });
  it("hides while features are unknown", () => {
    methods = undefined;
    setup();
    expect(screen.queryByTestId("batch-ship-open")).toBeNull();
  });

  it("opens a dialog with one row per selected order", () => {
    setup();
    fireEvent.click(screen.getByTestId("batch-ship-open"));
    for (const o of orders) {
      expect(screen.getByTestId(`batch-ship-row-${o.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`batch-ship-tracking-${o.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`batch-ship-carrier-${o.id}`)).toBeInTheDocument();
    }
  });

  it("sends carrier+tracking only for rows with a tracking number", async () => {
    batchMutateAsync.mockResolvedValue({ results: [] });
    setup();
    fireEvent.click(screen.getByTestId("batch-ship-open"));
    fireEvent.change(screen.getByTestId("batch-ship-tracking-o1"), { target: { value: " 1Z1 " } });
    fireEvent.change(screen.getByTestId("batch-ship-carrier-o1"), { target: { value: "fedex" } });
    fireEvent.click(screen.getByTestId("batch-ship-submit"));
    await waitFor(() => expect(batchMutateAsync).toHaveBeenCalled());
    expect(batchMutateAsync).toHaveBeenCalledWith({
      orders: [
        { orderId: "o1", carrier: "fedex", trackingNumber: "1Z1" },
        { orderId: "o2" },
        { orderId: "o3" },
      ],
    });
  });

  it("shows the copy per outcome and prints slips only for the orders that shipped", async () => {
    batchMutateAsync.mockResolvedValue({
      results: [
        { orderId: "o1", orderNumber: "SO-1", outcome: "SHIPPED", message: "" },
        { orderId: "o2", orderNumber: "SO-2", outcome: "CREDIT_HOLD", message: "" },
        { orderId: "o3", orderNumber: "SO-3", outcome: "ALREADY_SHIPPED", message: "" },
      ],
    });
    slipsMutateAsync.mockResolvedValue({
      url: "u",
      included: ["o1"],
      skipped: [],
      blob: new Blob(["x"]),
    });
    setup();
    fireEvent.click(screen.getByTestId("batch-ship-open"));
    fireEvent.click(screen.getByTestId("batch-ship-submit"));
    const r2 = await screen.findByTestId("batch-ship-result-o2");
    expect(r2).toHaveTextContent(BATCH_SHIP_COPY.CREDIT_HOLD.label);
    expect(screen.getByTestId("batch-ship-result-o1")).toHaveTextContent("Shipped");
    expect(screen.getByTestId("batch-ship-result-o3")).toHaveTextContent("Already shipped");
    fireEvent.click(screen.getByTestId("batch-ship-print-slips"));
    await waitFor(() => expect(slipsMutateAsync).toHaveBeenCalledWith(["o1"]));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalledTimes(1));
  });

  it("no Print button when nothing shipped", async () => {
    batchMutateAsync.mockResolvedValue({
      results: [{ orderId: "o1", orderNumber: "SO-1", outcome: "NOT_CONFIRMED", message: "" }],
    });
    setup();
    fireEvent.click(screen.getByTestId("batch-ship-open"));
    fireEvent.click(screen.getByTestId("batch-ship-submit"));
    await screen.findByTestId("batch-ship-result-o1");
    expect(screen.queryByTestId("batch-ship-print-slips")).toBeNull();
  });

  it("Done after a run calls onDone", async () => {
    batchMutateAsync.mockResolvedValue({ results: [] });
    const { onDone } = setup();
    fireEvent.click(screen.getByTestId("batch-ship-open"));
    fireEvent.click(screen.getByTestId("batch-ship-submit"));
    fireEvent.click(await screen.findByTestId("batch-ship-done"));
    expect(onDone).toHaveBeenCalled();
  });

  it("standalone Print packing slips prints the whole selection", async () => {
    slipsMutateAsync.mockResolvedValue({
      url: "u",
      included: [],
      skipped: [],
      blob: new Blob(["x"]),
    });
    setup();
    fireEvent.click(screen.getByTestId("batch-ship-slips-open"));
    await waitFor(() => expect(slipsMutateAsync).toHaveBeenCalledWith(["o1", "o2", "o3"]));
    await waitFor(() => expect(printPdfBlob).toHaveBeenCalled());
  });
});

describe("outcome copy", () => {
  it("every shared outcome has copy, and only the two SHIPPED outcomes count as shipped", () => {
    expect(Object.keys(BATCH_SHIP_COPY).sort()).toEqual([...BATCH_SHIP_OUTCOMES].sort());
    expect(
      shippedOrderIds(BATCH_SHIP_OUTCOMES.map((outcome) => ({ orderId: outcome, outcome }))).sort(),
    ).toEqual(["SHIPPED", "SHIPPED_INVOICE_PENDING"]);
  });
});
