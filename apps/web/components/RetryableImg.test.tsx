import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { RetryableImg } from "./RetryableImg";

/**
 * #2091: a product image recovers ONCE from a failed load — it refetches the query that minted
 * its URL and then remounts the <img> so the browser requests it again — never loops, and a
 * burst of failures on one query refetches it ONCE.
 */
function renderImgs(count: number) {
  const qc = createTestQueryClient();
  let release!: () => void;
  const settled = new Promise<void>((r) => (release = r));
  const invalidate = jest.spyOn(qc, "invalidateQueries").mockImplementation(() => settled);
  render(
    <QueryClientProvider client={qc}>
      {Array.from({ length: count }, (_, i) => (
        <RetryableImg
          key={i}
          staleQueryKey={["buyer", "products"]}
          src={`/img/${i}.png`}
          alt={`p${i}`}
        />
      ))}
    </QueryClientProvider>,
  );
  const settle = async () => {
    await act(async () => {
      release();
      await settled;
    });
  };
  return { invalidate, settle };
}

describe("RetryableImg (#2091)", () => {
  it("on the first error, refetches the owning query and remounts the image once it settles", async () => {
    const { invalidate, settle } = renderImgs(1);
    const first = screen.getByAltText("p0");
    fireEvent.error(first);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "products"] });
    await settle();
    // A remount is a NEW element, so the browser issues a fresh request.
    expect(screen.getByAltText("p0")).not.toBe(first);
  });

  it("a second failure stays failed — no refetch loop", async () => {
    const { invalidate, settle } = renderImgs(1);
    fireEvent.error(screen.getByAltText("p0"));
    await settle();
    fireEvent.error(screen.getByAltText("p0"));
    fireEvent.error(screen.getByAltText("p0"));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("20 simultaneous failures on one query refetch it ONCE, then every image retries", async () => {
    const { invalidate, settle } = renderImgs(20);
    const before = Array.from({ length: 20 }, (_, i) => screen.getByAltText(`p${i}`));
    before.forEach((img) => fireEvent.error(img));
    expect(invalidate).toHaveBeenCalledTimes(1);
    await settle();
    before.forEach((img, i) => expect(screen.getByAltText(`p${i}`)).not.toBe(img));
  });

  it("passes the image attributes through", () => {
    renderImgs(1);
    expect(screen.getByAltText("p0")).toHaveAttribute("src", "/img/0.png");
  });
});
