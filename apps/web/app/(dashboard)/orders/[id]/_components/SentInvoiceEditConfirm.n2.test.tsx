import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen } from "@testing-library/react";
import { sentRevertNumbersOf, useSentInvoiceEditConfirm } from "./SentInvoiceEditConfirm";

/**
 * B1372 N2 (SA-1177 A2 K3): the server enforces the confirm. A confirmed save carries `ackSentRevert: true`; an invoice
 * sent after the page was read comes back as 409 ORDER_EDIT_REVERTS_SENT_INVOICE naming it, which opens the SAME confirm
 * with the server's numbers, and "Edit anyway" retries with the ack. Placeholders only.
 */
const conflict = (invoiceNumbers: unknown) => ({
  response: { status: 409, data: { code: "ORDER_EDIT_REVERTS_SENT_INVOICE", invoiceNumbers } },
});

/** A save that sends `ack()` with each attempt and fails the first one with `firstError` (the server's 409). */
function Harness({ numbers, firstError }: { numbers?: string[]; firstError?: unknown }) {
  const confirm = useSentInvoiceEditConfirm(numbers, true);
  const sent = React.useRef<Array<Record<string, unknown>>>([]);
  const [log, setLog] = React.useState("");
  const onSave = () => {
    if (confirm.ask(onSave)) return;
    const body = { items: [], ...confirm.ack() };
    sent.current.push(body);
    setLog(JSON.stringify(sent.current));
    if (sent.current.length === 1 && firstError && !confirm.capture(firstError, onSave)) {
      setLog("toast");
    }
  };
  return (
    <>
      <button onClick={onSave}>Save</button>
      <output data-testid="sent">{log}</output>
      {confirm.dialog}
    </>
  );
}
const sentBodies = () => JSON.parse(screen.getByTestId("sent").textContent || "[]");

describe("useSentInvoiceEditConfirm: the server-enforced confirm (B1372 N2)", () => {
  it("PIN: Edit anyway sends ackSentRevert: true with the save", () => {
    render(<Harness numbers={["INV-1"]} />);
    fireEvent.click(screen.getByText("Save"));
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    expect(sentBodies()).toEqual([{ items: [], ackSentRevert: true }]);
  });

  it("nothing to confirm: the save carries no ack", () => {
    render(<Harness numbers={[]} />);
    fireEvent.click(screen.getByText("Save"));
    expect(sentBodies()).toEqual([{ items: [] }]);
  });

  it("PIN: a 409 naming an invoice sent after the read opens the confirm with the SERVER's numbers, then retries with the ack", () => {
    render(<Harness numbers={[]} firstError={conflict(["INV-9"])} />);
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByText(/Invoice INV-9 was already sent\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    expect(sentBodies()).toEqual([{ items: [] }, { items: [], ackSentRevert: true }]);
  });

  it("Cancel on the server's confirm sends nothing more", () => {
    render(<Harness numbers={[]} firstError={conflict(["INV-9"])} />);
    fireEvent.click(screen.getByText("Save"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sentBodies()).toEqual([{ items: [] }]);
  });

  it("any other error is not captured (it goes to the page's other guards and the toast)", () => {
    const other = { response: { status: 409, data: { code: "ORDER_REVISION_STALE" } } };
    render(<Harness numbers={[]} firstError={other} />);
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByTestId("sent").textContent).toBe("toast");
  });
});

describe("sentRevertNumbersOf (B1372 N2)", () => {
  it("reads the numbers of the 409, and only of this code", () => {
    expect(sentRevertNumbersOf(conflict(["INV-1", "INV-2"]))).toEqual(["INV-1", "INV-2"]);
    expect(sentRevertNumbersOf(conflict(undefined))).toEqual([]);
    expect(sentRevertNumbersOf({ response: { status: 400, data: { code: "X" } } })).toBeNull();
    expect(sentRevertNumbersOf(new Error("network"))).toBeNull();
  });
});

describe("the order page wires the N2 confirm into BOTH save paths (B1372 N2)", () => {
  const page = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
  const mutateBodies = (): string[] => {
    const sites: string[] = [];
    for (
      let at = page.indexOf("updateItems.mutate(");
      at !== -1;
      at = page.indexOf("updateItems.mutate(", at + 1)
    ) {
      const open = page.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (; end < page.length; end++) {
        if (page[end] === "{") depth++;
        if (page[end] === "}" && --depth === 0) break;
      }
      sites.push(page.slice(open, end + 1));
    }
    return sites;
  };

  it("Save (handleSaveItems) and Save-then-publish (saveThenPublish) both send the ack", () => {
    const sites = mutateBodies();
    expect(sites.length).toBeGreaterThanOrEqual(2); // a silent no-match cannot pass
    for (const body of sites) expect(body).toContain("...sentEdit.ack()");
  });

  it("both retry through guardError, which hands the 409 to the confirm; the confirm owns the toast", () => {
    expect(page).toContain("guardError(() => handleSaveItems())");
    expect(page).toContain("guardError(() => saveThenPublish())");
    expect(page).toContain("sentEdit.capture(err, retry)");
    expect(page).toContain("sentEdit.ownsToast(e)");
  });
});
