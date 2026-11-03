import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { API_ERROR_CODES } from "@routeflow/types";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import { handleMutationError } from "@/lib/mutation-error-toast";
import { packReadingCopy, usePackReadingSave } from "./PackReadingAsk";

/** SA-961 R1: the save goes first; the server's 409 opens the question, and the answer re-sends the same save. */
const required = {
  response: { status: 409, data: { code: API_ERROR_CODES.PACK_READING_REQUIRED } },
};

function Harness({
  mutation,
  onResult,
  options,
  useAsync,
}: {
  mutation: { mutate: jest.Mock; mutateAsync: jest.Mock };
  onResult?: (r: unknown) => void;
  options?: Record<string, unknown>;
  useAsync?: boolean;
}) {
  const save = usePackReadingSave(mutation as any);
  const vars = { id: "p1", name: "Acme", unitsPerBox: 24 };
  return (
    <>
      <button
        onClick={() =>
          useAsync
            ? save.mutateAsync(vars, 240).then(onResult, onResult)
            : save.mutate(vars, options ?? {}, 240)
        }
      >
        Save
      </button>
      {save.dialog}
    </>
  );
}

describe("packReadingCopy", () => {
  it("PI-W1: asks about the stock number, and says what each answer does", () => {
    expect(packReadingCopy(240, 24)).toEqual({
      question: "Your stock shows 240. Is that 240 boxes or 240 pieces?",
      box: {
        label: "Boxes",
        preview: "Stock will be 5,760 pieces (240 × 24), and cost is divided by 24.",
      },
      piece: { label: "Pieces", preview: "Stock stays 240 pieces." },
    });
  });

  it("PI-W2: one on hand reads as one", () => {
    const copy = packReadingCopy(1, 24);
    expect(copy.question).toBe("Your stock shows 1. Is that 1 box or 1 piece?");
    expect(copy.piece.preview).toBe("Stock stays 1 piece.");
  });

  it("PI-W3: a cost and no stock asks about the cost", () => {
    expect(packReadingCopy(0, 24)).toEqual({
      question: "Is this product's cost for a box of 24, or for one piece?",
      box: { label: "A box", preview: "Cost is divided by 24." },
      piece: { label: "One piece", preview: "Cost stays as it is." },
    });
  });
});

describe("usePackReadingSave", () => {
  it("PI-W4: the 409 asks, nothing shows as an error, and Boxes re-sends the same save with the answer", async () => {
    const user = userEvent.setup();
    const onError = jest.fn();
    const onSuccess = jest.fn();
    const mutation = {
      mutate: jest.fn((_vars, opts) => opts.onError(required)),
      mutateAsync: jest.fn(),
    };
    renderWithProviders(<Harness mutation={mutation} options={{ onError, onSuccess }} />);

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Your stock shows 240. Is that 240 boxes or 240 pieces?"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stock will be 5,760 pieces/)).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();

    mutation.mutate.mockImplementation((_vars, opts) => opts.onSuccess({}));
    await user.click(screen.getByRole("button", { name: "Boxes" }));

    await waitFor(() => expect(mutation.mutate).toHaveBeenCalledTimes(2));
    expect(mutation.mutate.mock.calls[1][0]).toEqual({
      id: "p1",
      name: "Acme",
      unitsPerBox: 24,
      packReading: "box",
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText(/Your stock shows/)).not.toBeInTheDocument();
  });

  it("PI-W5: Pieces sends the piece answer", async () => {
    const user = userEvent.setup();
    const mutation = {
      mutate: jest.fn((_vars, opts) => opts.onError(required)),
      mutateAsync: jest.fn(),
    };
    renderWithProviders(<Harness mutation={mutation} />);

    await user.click(screen.getByRole("button", { name: "Save" }));
    mutation.mutate.mockImplementation(() => undefined);
    await user.click(await screen.findByRole("button", { name: "Pieces" }));

    await waitFor(() => expect(mutation.mutate).toHaveBeenCalledTimes(2));
    expect(mutation.mutate.mock.calls[1][0].packReading).toBe("piece");
  });

  it("PI-W6: closing it saves nothing and reports no failure", async () => {
    const user = userEvent.setup();
    const onError = jest.fn();
    const mutation = {
      mutate: jest.fn((_vars, opts) => opts.onError(required)),
      mutateAsync: jest.fn(),
    };
    renderWithProviders(<Harness mutation={mutation} options={{ onError }} />);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Your stock shows/);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText(/Your stock shows/)).not.toBeInTheDocument());
    expect(mutation.mutate).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("PI-W7: any other failure goes to the page as before, with no question", async () => {
    const user = userEvent.setup();
    const onError = jest.fn();
    const other = { response: { status: 500, data: {} } };
    const mutation = {
      mutate: jest.fn((_vars, opts) => opts.onError(other, _vars, undefined)),
      mutateAsync: jest.fn(),
    };
    renderWithProviders(<Harness mutation={mutation} options={{ onError }} />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toBe(other);
    expect(screen.queryByRole("button", { name: "Boxes" })).not.toBeInTheDocument();
  });

  describe("mutateAsync", () => {
    const run = async (first: () => Promise<unknown>, answer?: string) => {
      const user = userEvent.setup();
      const onResult = jest.fn();
      const mutation = {
        mutate: jest.fn(),
        mutateAsync: jest.fn(first),
      };
      renderWithProviders(<Harness mutation={mutation} onResult={onResult} useAsync />);
      await user.click(screen.getByRole("button", { name: "Save" }));
      if (answer) {
        mutation.mutateAsync.mockImplementation(async () => ({ ok: true }));
        await user.click(await screen.findByRole("button", { name: answer }));
      }
      return { mutation, onResult };
    };

    it("PI-W8: no question needed: says nothing was answered", async () => {
      const { onResult } = await run(async () => ({ ok: true }));
      await waitFor(() => expect(onResult).toHaveBeenCalledWith({ answered: null }));
    });

    it("PI-W9: the answer re-sends and is reported, so the list keeps no Undo for it", async () => {
      const { mutation, onResult } = await run(() => Promise.reject(required), "Boxes");
      await waitFor(() => expect(onResult).toHaveBeenCalledWith({ answered: "box" }));
      expect((mutation.mutateAsync.mock.calls as unknown[][])[1][0]).toMatchObject({
        packReading: "box",
      });
    });

    it("PI-W10: closing it resolves null and sends nothing more", async () => {
      const user = userEvent.setup();
      const { mutation, onResult } = await run(() => Promise.reject(required));
      await screen.findByText(/Your stock shows/);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
      expect(mutation.mutateAsync).toHaveBeenCalledTimes(1);
    });

    it("PI-W11: another failure still rejects", async () => {
      const other = { response: { status: 500, data: {} } };
      const { onResult } = await run(() => Promise.reject(other));
      await waitFor(() => expect(onResult).toHaveBeenCalledWith(other));
    });
  });
});

describe("the errors around it", () => {
  it("PI-W12: the global handler stays quiet on the question's 409", () => {
    const toast = jest.fn();
    handleMutationError(required, { meta: {} }, toast, { push: jest.fn() });
    expect(toast).not.toHaveBeenCalled();
  });

  it("PI-W13: a conversion too large for its column has its own sentence", () => {
    expect(
      codedToastCopy({
        response: { status: 409, data: { code: API_ERROR_CODES.PACK_CONVERSION_TOO_LARGE } },
      }),
    ).toBe("That many pieces won't fit. Choose Pieces, or use a smaller pack size.");
  });
});
