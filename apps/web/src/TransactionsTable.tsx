import {
  columnFacetingFeature,
  columnFilteringFeature,
  createColumnHelper,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_equalsString,
  filterFn_inDateRange,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type FilterFn,
} from "@tanstack/react-table";
import type { TransactionRow } from "./api";
import { formatAmount, formatDate } from "./format";

export interface AmountFilter {
  direction: "all" | "in" | "out";
  /** Bounds on the absolute amount, as typed; blank means unbounded. */
  min: string;
  max: string;
}

const amountFilter: FilterFn<typeof features, TransactionRow> = (row, columnId, value: AmountFilter) => {
  const amount = row.getValue<number>(columnId);
  if (value.direction === "in" && amount < 0) return false;
  if (value.direction === "out" && amount >= 0) return false;
  const abs = Math.abs(amount);
  const min = parseFloat(value.min);
  const max = parseFloat(value.max);
  return (Number.isNaN(min) || abs >= min) && (Number.isNaN(max) || abs <= max);
};
amountFilter.autoRemove = (value?: AmountFilter) => !value || (value.direction === "all" && !value.min && !value.max);

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString, equalsString: filterFn_equalsString, inDateRange: filterFn_inDateRange },
  columnFacetingFeature,
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

const helper = createColumnHelper<typeof features, TransactionRow>();

const columns = helper.columns([
  helper.accessor("postedDate", {
    header: "Date",
    sortFn: "text",
    filterFn: "inDateRange",
    cell: ({ getValue }) => formatDate(getValue()),
  }),
  helper.accessor("accountName", { header: "Account", sortFn: "text", filterFn: "equalsString" }),
  helper.accessor("section", { header: "Section", sortFn: "text", filterFn: "equalsString" }),
  helper.accessor("type", { header: "Type", sortFn: "text", filterFn: "equalsString" }),
  helper.accessor((t) => [t.description, ...t.details].join(" "), {
    id: "description",
    header: "Description",
    sortFn: "alphanumeric",
    filterFn: "includesString",
    cell: ({ row }) => (
      <>
        <div>{row.original.description}</div>
        {row.original.details.map((detail, i) => (
          <div key={i} className="detail">
            {detail}
          </div>
        ))}
      </>
    ),
  }),
  helper.accessor((t) => t.cardLast4 ?? "", { id: "card", header: "Card", sortFn: "text" }),
  helper.accessor("amount", {
    header: "Amount",
    filterFn: amountFilter,
    cell: ({ getValue }) => <span className={getValue() < 0 ? "debit" : "credit"}>{formatAmount(getValue())}</span>,
  }),
]);

const initialState = {
  sorting: [{ id: "postedDate", desc: true }],
  pagination: { pageIndex: 0, pageSize: 50 },
};

const PAGE_SIZES = [25, 50, 100, 250];

export function TransactionsTable({ data }: { data: TransactionRow[] }) {
  const table = useTable({
    features,
    columns,
    data,
    initialState,
    globalFilterFn: "includesString",
    getColumnCanGlobalFilter: (column) => ["description", "type", "section", "accountName"].includes(column.id),
  });

  const filteredRows = table.getFilteredRowModel().rows;
  const total = filteredRows.reduce((sum, row) => sum + row.original.amount, 0);
  const { pageIndex, pageSize } = table.state.pagination;
  const hasFilters = table.state.columnFilters.length > 0 || Boolean(table.state.globalFilter);
  const accountCount = table.getColumn("accountName")?.getFacetedUniqueValues().size ?? 0;

  if (data.length === 0) {
    return <p className="empty">No transactions yet. Import a statement to get started.</p>;
  }

  const dateColumn = table.getColumn("postedDate")!;
  const [dateFrom = "", dateTo = ""] = (dateColumn.getFilterValue() as [string, string] | undefined) ?? [];
  const amountColumn = table.getColumn("amount")!;
  const amount = (amountColumn.getFilterValue() as AmountFilter | undefined) ?? { direction: "all", min: "", max: "" };
  const setAmount = (patch: Partial<AmountFilter>) => amountColumn.setFilterValue({ ...amount, ...patch });

  return (
    <section className="panel">
      <div className="filters">
        <label className="search">
          Search
          <input
            type="search"
            placeholder="Merchant, type, details…"
            value={(table.state.globalFilter as string | undefined) ?? ""}
            onChange={(e) => table.setGlobalFilter(e.target.value)}
          />
        </label>
        {accountCount > 1 && <FacetSelect table={table} columnId="accountName" label="Account" />}
        <FacetSelect table={table} columnId="section" label="Section" />
        <FacetSelect table={table} columnId="type" label="Type" />
        <label>
          From
          <input type="date" value={dateFrom} onChange={(e) => dateColumn.setFilterValue([e.target.value, dateTo])} />
        </label>
        <label>
          To
          <input type="date" value={dateTo} onChange={(e) => dateColumn.setFilterValue([dateFrom, e.target.value])} />
        </label>
        <label>
          Direction
          <select value={amount.direction} onChange={(e) => setAmount({ direction: e.target.value as AmountFilter["direction"] })}>
            <option value="all">All</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
        </label>
        <label className="amount">
          Min $
          <input type="number" min="0" step="0.01" value={amount.min} onChange={(e) => setAmount({ min: e.target.value })} />
        </label>
        <label className="amount">
          Max $
          <input type="number" min="0" step="0.01" value={amount.max} onChange={(e) => setAmount({ max: e.target.value })} />
        </label>
        <button
          type="button"
          disabled={!hasFilters}
          onClick={() => {
            table.resetColumnFilters();
            table.setGlobalFilter("");
          }}
        >
          Clear filters
        </button>
      </div>

      <p className="summary">
        {filteredRows.length === data.length
          ? `${data.length} transactions`
          : `${filteredRows.length} of ${data.length} transactions`}
        {" · net "}
        <span className={total < 0 ? "debit" : "credit"}>{formatAmount(total)}</span>
      </p>

      <div className="table-scroll">
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={header.column.id === "amount" ? "num" : undefined}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                    >
                      <button type="button" className="sort" onClick={header.column.getToggleSortingHandler()}>
                        <table.FlexRender header={header} />
                        <span className="sort-indicator">{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className={cell.column.id === "amount" ? "num" : undefined}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  No transactions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button type="button" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
          Previous
        </button>
        <span>
          Page {pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
        </span>
        <button type="button" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
          Next
        </button>
        <select value={pageSize} onChange={(e) => table.setPageSize(Number(e.target.value))} aria-label="Rows per page">
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

type Table = ReturnType<typeof useTable<typeof features, TransactionRow>>;

/** Dropdown of the values present in a column, given the other active filters. */
function FacetSelect({ table, columnId, label }: { table: Table; columnId: string; label: string }) {
  const column = table.getColumn(columnId)!;
  const values = [...column.getFacetedUniqueValues().entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
  return (
    <label>
      {label}
      <select value={(column.getFilterValue() as string | undefined) ?? ""} onChange={(e) => column.setFilterValue(e.target.value || undefined)}>
        <option value="">All</option>
        {values.map(([value, count]) => (
          <option key={String(value)} value={String(value)}>
            {String(value)} ({count})
          </option>
        ))}
      </select>
    </label>
  );
}
