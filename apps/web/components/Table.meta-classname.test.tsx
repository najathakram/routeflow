import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Table } from "@routeflow/ui/web";
import type { ColumnDef } from "@tanstack/react-table";

type Row = { a: string; b: string };
const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "a", header: "A", cell: ({ row }) => row.original.a },
  {
    accessorKey: "b",
    header: "B",
    meta: { className: "hidden sm:table-cell" },
    cell: ({ row }) => <span data-testid="b-cell">{row.original.b}</span>,
  },
];

describe("Table column meta.className", () => {
  it("applies the class to the th and every td of that column only", () => {
    render(<Table data={[{ a: "1", b: "2" }]} columns={columns} />);
    expect(screen.getByRole("columnheader", { name: "B" })).toHaveClass("hidden", "sm:table-cell");
    expect(screen.getByTestId("b-cell").closest("td")).toHaveClass("hidden", "sm:table-cell");
    expect(screen.getByRole("columnheader", { name: "A" })).not.toHaveClass("hidden");
    expect(screen.getByText("1").closest("td")).not.toHaveClass("hidden");
  });
});
