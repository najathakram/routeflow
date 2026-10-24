import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useMutation } from "@tanstack/react-query";
import { Providers } from "@/app/providers";
import { apiClient } from "@/lib/api-client";
import { parseSellingRestricted } from "@/lib/api/selling-restricted";
import { BlockedLinesDialog } from "./BlockedLinesDialog";

/**
 * End to end for the message contract: the REAL global MutationCache handler (app/providers.tsx)
 * around a component that wires the dialog exactly like the order modals do. A blocked save must
 * show the dialog and NO toast (SELLING_RESTRICTED is in HANDLED_CODES); any other error still gets
 * the global handler's single toast.
 */
const toast = jest.fn();
const post = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => post(...a) },
}));

function Host() {
  const save = useMutation({ mutationFn: () => apiClient.post("/orders", {}) });
  const [lines, setLines] = React.useState<ReturnType<typeof parseSellingRestricted>>(null);
  return (
    <>
      <button
        onClick={() =>
          save.mutate(undefined, { onError: (e) => setLines(parseSellingRestricted(e)) })
        }
      >
        Save
      </button>
      <BlockedLinesDialog lines={lines} onClose={() => setLines(null)} />
    </>
  );
}
const reject = (status: number, data: object) =>
  post.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );
const save = () => {
  render(
    <Providers>
      <Host />
    </Providers>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
};

beforeEach(() => jest.clearAllMocks());

describe("a blocked save gives one message", () => {
  it("SELLING_RESTRICTED: the dialog only, no toast (not the raw 'Request failed')", async () => {
    reject(409, {
      code: "SELLING_RESTRICTED",
      blockedLines: [
        {
          productId: "p1",
          productName: "Hemp Gummies",
          ruleId: "r1",
          reason: "FEDERAL_BAN",
          message: "m",
        },
      ],
    });
    save();
    expect(await screen.findByText("Hemp Gummies")).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("any other error: the global handler's single toast, and no dialog", async () => {
    reject(500, { message: "Boom" });
    save();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: "Something went wrong on our side. Please try again.",
      variant: "error",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
