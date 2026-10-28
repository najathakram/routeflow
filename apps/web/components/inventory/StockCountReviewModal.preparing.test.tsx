import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { stockCountPreparingLine } from "@routeflow/types";
import { StockCountReviewModal } from "./StockCountReviewModal";
import type { StockCountLocalRow } from "@/lib/api/stock-count";

/**
 * SA-999: while a count's seed has not finished, the review screen says "Preparing count… {seeded} of
 * {planned}" and Commit stays disabled (the server answers 409 STOCK_COUNT_SEEDING until the seed finishes).
 */
const ROW: StockCountLocalRow = {
  productId: "p-1",
  name: "Cola",
  sku: "CO-1",
  unit: "each",
  currentStock: 10,
  expectedQty: 10,
  countedQty: 7,
  mode: "REPLACE",
  averageCost: 2,
  countedById: "u-1",
  updatedAt: "2026-10-26T00:00:00Z",
  lineId: "line-1",
};

function show(preparingCopy: string | null, onConfirm = jest.fn()) {
  renderWithProviders(
    <StockCountReviewModal
      isOpen
      rows={[ROW]}
      notes=""
      onChangeNotes={jest.fn()}
      onClose={jest.fn()}
      onConfirm={onConfirm}
      isSubmitting={false}
      unsavedCount={0}
      syncError={false}
      onRetrySync={jest.fn()}
      onChangeQty={jest.fn()}
      onChangeUnitCost={jest.fn()}
      onRemoveRow={jest.fn()}
      uncountedCount={0}
      commitStatus={{
        preparingCopy,
        savingCopy: null,
        notice: null,
        canFinishWithSkips: false,
        finishWithSkipsLabel: "Finish with skips",
        onFinishWithSkips: jest.fn(),
      }}
    />,
  );
  return onConfirm;
}
const commitButton = () => screen.getByRole("button", { name: /^Commit 1 change$/ });

describe("StockCountReviewModal while the count is being prepared (SA-999)", () => {
  it("says 'Preparing count… 200 of 450' and keeps Commit disabled", () => {
    const onConfirm = show(
      stockCountPreparingLine({ seedPlannedLines: 450, seedCompletedAt: null }, 200),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preparing count… 200 of 450");
    expect(commitButton()).toBeDisabled();
    fireEvent.click(commitButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a count that finished preparing shows no such line and Commit works", () => {
    const line = stockCountPreparingLine(
      { seedPlannedLines: 450, seedCompletedAt: "2026-10-26T00:01:00Z" },
      450,
    );
    expect(line).toBeNull();
    const onConfirm = show(line);

    expect(screen.queryByText(/Preparing count/)).toBeNull();
    expect(commitButton()).toBeEnabled();
    fireEvent.click(commitButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
