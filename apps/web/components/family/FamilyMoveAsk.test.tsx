import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FamilyMovePreviewDto } from "@routeflow/types";
import { previewFamilyMove } from "@/lib/api/products";
import {
  familyMoveQuestion,
  familyMoveResult,
  useFamilyMoveAsk,
  type FamilyMoveAnswer,
} from "./FamilyMoveAsk";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));
jest.mock("@/lib/api/products", () => ({ previewFamilyMove: jest.fn() }));
const preview = previewFamilyMove as jest.Mock;

const THREE: FamilyMovePreviewDto = {
  count: 3,
  variants: ["v1", "v2", "v3"].map((id) => ({ id, name: `Acme ${id}`, from: 24, to: 26 })),
  retailFrom: 24,
  retailTo: 26,
};

function Harness({ onAnswer }: { onAnswer: (a: FamilyMoveAnswer) => void }) {
  const { ask, dialog } = useFamilyMoveAsk();
  return (
    <>
      <button onClick={() => void ask("f1", { pricePerUnit: "26" }).then(onAnswer)}>Save</button>
      {dialog}
    </>
  );
}

async function save() {
  const onAnswer = jest.fn();
  const user = userEvent.setup();
  render(<Harness onAnswer={onAnswer} />);
  await user.click(screen.getByText("Save"));
  return { user, onAnswer };
}

beforeEach(() => jest.clearAllMocks());

describe("VM-W1: the family save asks, and the person decides", () => {
  it("says how many, from what and to what, and that the others stay", async () => {
    preview.mockResolvedValue(THREE);
    await save();
    expect(preview).toHaveBeenCalledWith("f1", { pricePerUnit: "26" });
    expect(await screen.findByText("Move the 3 variants at $24.00 to $26.00?")).toBeInTheDocument();
    expect(screen.getByText("Variants with a different price stay as they are.")).toBeVisible();
    expect(within(screen.getByTestId("family-move-list")).getAllByRole("listitem")).toHaveLength(3);
  });

  it("Move them sends every listed id", async () => {
    preview.mockResolvedValue(THREE);
    const { user, onAnswer } = await save();
    await user.click(await screen.findByTestId("family-move-confirm"));
    expect(onAnswer).toHaveBeenCalledWith({ moveVariantIds: ["v1", "v2", "v3"] });
    expect(screen.queryByTestId("family-move-list")).toBeNull();
  });

  it("Keep their prices saves the family with no list", async () => {
    preview.mockResolvedValue(THREE);
    const { user, onAnswer } = await save();
    await user.click(await screen.findByTestId("family-move-keep"));
    expect(onAnswer).toHaveBeenCalledWith({});
  });

  it("closing the question saves nothing", async () => {
    preview.mockResolvedValue(THREE);
    const { user, onAnswer } = await save();
    await screen.findByTestId("family-move-list");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(null));
  });

  it("a read that fails stops the save, and says nothing changed", async () => {
    preview.mockRejectedValue(new Error("offline"));
    const { onAnswer } = await save();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(null));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't save the family price",
        description: "We couldn't check its variants. Nothing changed. Try again.",
        variant: "error",
      }),
    );
  });
});

describe("VM-W2: no one at the family's price, no question", () => {
  it("resolves with nothing to carry and shows nothing", async () => {
    preview.mockResolvedValue({ count: 0, variants: [], retailFrom: 24, retailTo: 26 });
    const { onAnswer } = await save();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({}));
    expect(screen.queryByTestId("family-move-list")).toBeNull();
  });
});

describe("the words", () => {
  it("one variant reads as one", () => {
    expect(
      familyMoveQuestion({
        count: 1,
        variants: [{ id: "v1", name: "A", from: 24, to: 26 }],
        retailFrom: 24,
        retailTo: 26,
      }),
    ).toBe("Move the variant at $24.00 to $26.00?");
  });

  it("packs that differ have no one number to name, so the list names them", () => {
    expect(
      familyMoveQuestion({
        count: 2,
        variants: [
          { id: "v1", name: "A", from: 24, to: 26 },
          { id: "v2", name: "B", from: 12, to: 13 },
        ],
        retailFrom: 24,
        retailTo: 26,
      }),
    ).toBe("Move the 2 variants at the family's prices?");
  });

  it("the list stops at five and says how many more", async () => {
    preview.mockResolvedValue({
      count: 7,
      variants: Array.from({ length: 7 }, (_, i) => ({
        id: `v${i}`,
        name: `V${i}`,
        from: 1,
        to: 2,
      })),
      retailFrom: 1,
      retailTo: 2,
    });
    await save();
    expect(await screen.findByText("and 2 more")).toBeInTheDocument();
    expect(screen.queryByText("V5")).toBeNull();
  });

  it("the result names what happened, and only after a list was sent", () => {
    expect(familyMoveResult(0, undefined)).toBeUndefined();
    expect(familyMoveResult(3, undefined)).toBeUndefined();
    expect(familyMoveResult(3, 3)).toBe("3 variants moved.");
    expect(familyMoveResult(1, 1)).toBe("1 variant moved.");
    expect(familyMoveResult(3, 2)).toBe(
      "2 of 3 variants moved. The others changed since you were asked, so they kept their prices.",
    );
  });
});
