import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EmbeddedCheckoutHost } from "./EmbeddedCheckoutHost";
import {
  closeEmbeddedCheckout,
  getEmbeddedCheckoutSecret,
  openEmbeddedCheckout,
} from "@/lib/checkout-embedded";

/**
 * SA-1154: the panel is a lazy chunk. While it loads, the host shows a sheet that says so; when the chunk itself fails
 * (deploy skew, a dropped connection) the person sees one calm line and Back, never Next's default error page, and
 * nothing was charged because the form never mounted.
 */
jest.mock("./EmbeddedCheckoutPanel", () => {
  throw new Error("ChunkLoadError: Loading chunk failed");
});
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

function renderHost() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EmbeddedCheckoutHost />
    </QueryClientProvider>,
  );
}

describe("EmbeddedCheckoutHost when the panel chunk cannot load", () => {
  beforeEach(() => closeEmbeddedCheckout());

  it("shows the loading sheet first, then the failed line with Back, and renders no default error page", async () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_x", "/settings/billing?paid=1"));
    expect(screen.getByRole("dialog", { name: "Payment" })).toBeInTheDocument();
    expect(screen.getByText("Loading the payment form…")).toBeInTheDocument();
    expect(
      await screen.findByText("The payment form didn't load. Nothing was charged."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading the payment form…")).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("Back from the failed sheet closes it and drops the secret", async () => {
    renderHost();
    act(() => openEmbeddedCheckout("cs_secret_y", "/settings/billing?paid=1"));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getEmbeddedCheckoutSecret()).toBeNull();
  });
});
