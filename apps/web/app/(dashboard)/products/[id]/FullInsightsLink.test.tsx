import * as React from "react";
import { render, screen } from "@testing-library/react";
import { FullInsightsLink } from "./FullInsightsLink";

// SA-1087 IN-2 / IN-3: the link is offered only to what the endpoint serves.
const mockUser = jest.fn();
const mockFlag = jest.fn();
const mockDenied = jest.fn();
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: mockUser() }) }));
jest.mock("@/lib/api/plan-flags", () => ({ usePlanFlag: (...a: unknown[]) => mockFlag(...a) }));
jest.mock("@/lib/api/my-permissions", () => ({ useDeniedGroups: () => mockDenied() }));

const on = { enabled: true, resolved: true, failed: false };

beforeEach(() => {
  mockUser.mockReturnValue({ id: "u1", role: "OPERATOR" });
  mockFlag.mockReturnValue(on);
  mockDenied.mockReturnValue([]);
});

describe("FullInsightsLink", () => {
  it("links staff with REPORTS to the product's insights page", () => {
    render(<FullInsightsLink productId="p1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toHaveAttribute(
      "href",
      "/insights/products/p1",
    );
    expect(mockFlag).toHaveBeenCalledWith("flag.analytics");
  });

  it("an admin sees it too", () => {
    mockUser.mockReturnValue({ id: "u1", role: "TENANT_ADMIN" });
    render(<FullInsightsLink productId="p1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toBeInTheDocument();
  });

  it("IN-2: staff without REPORTS see no link", () => {
    mockDenied.mockReturnValue(["REPORTS"]);
    render(<FullInsightsLink productId="p1" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("a group other than REPORTS switched off does not hide it", () => {
    mockDenied.mockReturnValue(["FINANCE"]);
    render(<FullInsightsLink productId="p1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toBeInTheDocument();
  });

  it("IN-3: a plan without flag.analytics sees no link", () => {
    mockFlag.mockReturnValue({ enabled: false, resolved: true, failed: false });
    render(<FullInsightsLink productId="p1" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows nothing while the plan answer is loading, and fails open if it failed", () => {
    mockFlag.mockReturnValue({ enabled: false, resolved: false, failed: false });
    const { unmount } = render(<FullInsightsLink productId="p1" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    unmount();
    mockFlag.mockReturnValue({ enabled: false, resolved: false, failed: true });
    render(<FullInsightsLink productId="p1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toBeInTheDocument();
  });

  it("a driver or store login sees no link", () => {
    mockUser.mockReturnValue({ id: "u1", role: "DRIVER" });
    render(<FullInsightsLink productId="p1" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
