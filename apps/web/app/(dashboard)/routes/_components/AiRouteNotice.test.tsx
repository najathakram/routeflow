/**
 * SA-1102 A-3 RA-2: the route analysis notice names the real reason the AI notes are missing. Over the monthly
 * allowance it says when they come back; when RouteFlow's key is not set it says they are not available. Neither
 * sends the business to a key that does nothing, and the templates page uses this component and no other copy.
 */
import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { RouteAnalysisResult } from "@/lib/api/routes";
import { AiRouteNotice } from "./AiRouteNotice";

const result = (over: Partial<RouteAnalysisResult>): RouteAnalysisResult => ({
  configured: false,
  etas: [],
  ...over,
});

describe("AiRouteNotice (SA-1102 A-3 RA-2)", () => {
  it("cap: says the AI route notes are paused until the reset date, and the ETAs are below", () => {
    render(
      <AiRouteNotice
        result={result({ aiUnavailable: "cap", aiResetsAt: "2026-12-01T00:00:00.000Z" })}
      />,
    );
    expect(
      screen.getByText("AI route notes are paused until December 1. Your ETAs are below."),
    ).toBeInTheDocument();
  });

  it("cap: the date is the UTC 1st, whatever zone the browser is in", () => {
    render(
      <AiRouteNotice
        result={result({ aiUnavailable: "cap", aiResetsAt: "2027-01-01T00:00:00.000Z" })}
      />,
    );
    expect(screen.getByText(/paused until January 1\./)).toBeInTheDocument();
  });

  it("unavailable: says the notes are not available right now, and the ETAs are below", () => {
    render(<AiRouteNotice result={result({ aiUnavailable: "unavailable" })} />);
    expect(
      screen.getByText("AI route notes aren't available right now. Your ETAs are below."),
    ).toBeInTheDocument();
  });

  it.each([
    ["cap", { aiUnavailable: "cap", aiResetsAt: "2026-12-01T00:00:00.000Z" } as const],
    ["unavailable", { aiUnavailable: "unavailable" } as const],
  ])("%s: the words 'Anthropic API key' appear nowhere", (_name, over) => {
    const { container } = render(<AiRouteNotice result={result(over)} />);
    expect(container.textContent).not.toMatch(/anthropic|api key/i);
  });

  it("renders nothing when the AI notes are present or the response carries no reason", () => {
    const ok = render(<AiRouteNotice result={result({ configured: true })} />);
    expect(ok.container).toBeEmptyDOMElement();
    const legacy = render(<AiRouteNotice result={result({})} />);
    expect(legacy.container).toBeEmptyDOMElement();
  });

  it("the templates page shows this notice and no longer carries the configure-a-key sentence", () => {
    const page = fs.readFileSync(path.join(__dirname, "../templates/[id]/page.tsx"), "utf8");
    expect(page).toContain("<AiRouteNotice");
    expect(page).not.toMatch(/Anthropic API key/i);
  });
});
