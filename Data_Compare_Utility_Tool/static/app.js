const { useState, useEffect, useMemo, useRef, useCallback } = React;

const STEPS = ["Start", "Upload", "Select sheets", "Map columns", "Rules", "Validate", "Compare"];

const TABS = [
  {
    id: "compare",
    label: "Differences side by side",
    blurb: "Only the rows that differ, shown with both files side by side and lined up row " +
      "for row on the key, so you can read a record against its counterpart. Rows that match " +
      "on every compared column are left out — those are in the Matching rows tab. Use the » " +
      "button to jump straight to the first differing cell in a row; sorting, paging and " +
      "scrolling move both tables at once.",
  },
  {
    id: "common",
    label: "Matching rows",
    blurb: "Rows that exist in both files and agree on every compared value once the " +
      "normalisation rules are applied. Nothing here needs your attention.",
  },
  {
    id: "mismatch_first",
    label: "First file mismatches",
    blurb: "Rows as they appear in the first file that either differ from their counterpart " +
      "in the second file or have no counterpart at all. Yellow cells are the values that " +
      "differ, red rows exist only here. Use the » button to jump straight to the difference.",
  },
  {
    id: "mismatch_second",
    label: "Second file mismatches",
    blurb: "The same rows seen from the second file's side, so you can read the other half of " +
      "each difference. Yellow cells are the values that differ, red rows exist only here. " +
      "Use the » button to jump straight to the difference.",
  },
  {
    id: "duplicate",
    label: "Duplicates",
    blurb: "Keys that appear more than once inside a single file. Duplicates are reported " +
      "rather than compared, because a repeated key cannot be paired up reliably.",
  },
  {
    id: "summary",
    label: "Summary",
    blurb: "A plain-language sentence per changed row, spelling out which column changed and " +
      "what the value went from and to.",
  },
];

const RULE_LABELS = {
  trim_spaces: "Trim spaces",
  case_insensitive: "Case insensitive",
  blank_null_equal: "Blank equals null",
  normalize_numbers: "Normalize numbers",
  normalize_dates: "Normalize dates",
  ignore_unmapped_columns: "Ignore unmapped columns",
};

const emptyTabState = () => ({
  query: "",
  leftQuery: "",
  rightQuery: "",
  sortCol: null,
  sortAsc: true,
  sortLevels: [],
  appliedSortLevels: [],
  page: 1,
  pageSize: 25,
  selectedColumns: null,
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function friendlyError(message, status) {
  if (!message) return "Server error (" + status + ")";
  if (/database is locked|database table is locked/i.test(message)) {
    return "The database is busy with another request. Please retry in a moment.";
  }
  return message;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = null; // Flask returned an HTML error page.
  }
  if (!response.ok) {
    const error = new Error(friendlyError(data && data.error, response.status));
    error.payload = data;
    throw error;
  }
  return data;
}

async function apiBlob(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const text = await response.text();
    let message = null;
    try {
      message = JSON.parse(text).error;
    } catch (error) {
      message = null;
    }
    throw new Error(friendlyError(message, response.status));
  }
  return response.blob();
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function newOperationId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "op-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function cellText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function joinNames(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/* Plain-language reason a row was flagged. Mirrors describe_record in app/compare.py so
   the screen, the CSV and the workbook all say the same thing. */
function describeRecord(record) {
  const side = record.side === "right" ? "right" : "left";
  const other = side === "right" ? "left" : "right";
  if (record.is_missing) {
    return "This row is present in the " + side + " file but not in the " + other + " file.";
  }
  if (record.duplicate_count) {
    return "This key appears " + record.duplicate_count + " times in the " + side + " file.";
  }
  const columns = record.mismatch_cols || [];
  if (columns.length) {
    return joinNames(columns) + (columns.length === 1 ? " does" : " do")
      + " not match the " + other + " file.";
  }
  return "";
}

/* An aligned row is worth showing in the Compare tab only when something differs. */
function hasDifference(row) {
  return (row.mismatch_cols || []).length > 0 || row.is_missing_left || row.is_missing_right;
}

function compareText(a, b) {
  const left = cellText(a);
  const right = cellText(b);
  const leftNumber = Number(left.replace(/,/g, ""));
  const rightNumber = Number(right.replace(/,/g, ""));
  if (left !== "" && right !== "" && !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/* ------------------------------------------------------------------ */
/* small components                                                    */
/* ------------------------------------------------------------------ */

function Masthead() {
  return (
    <header className="masthead">
      <img src="/static/bmo_logo.png" alt="BMO" />
      <div className="center">
        <p className="eyebrow">Comparison workflow</p>
        <h1>Data Compare Utility</h1>
        <p className="sub">
          Upload, map, validate, and compare two spreadsheets with a clean review experience.
        </p>
      </div>
      <div className="right">
        <img src="/static/ibm_logo.png" alt="IBM" />
      </div>
    </header>
  );
}

function Stepper({ step }) {
  return (
    <nav className="stepper">
      {STEPS.map((label, index) => {
        const number = index + 1;
        const state = number < step ? "done" : number === step ? "active" : "";
        return (
          <div key={label} className={"step " + state}>
            <div className="bubble">{number}</div>
            <div>{label}</div>
          </div>
        );
      })}
    </nav>
  );
}

function Progress({ progress }) {
  if (!progress) return null;
  return (
    <div className="progress">
      <div className="track">
        <div className="fill" style={{ width: progress.percent + "%" }} />
      </div>
      <div className="label">
        <span>{progress.status}</span>
        <span>{progress.percent}%</span>
      </div>
    </div>
  );
}

function Busy({ label, busy }) {
  return (
    <React.Fragment>
      {busy ? <span className="spinner" /> : null}
      {label}
    </React.Fragment>
  );
}

function DropZone({ title, file, onFile, accept }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={"drop" + (dragging ? " dragging" : "")}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files && event.dataTransfer.files[0]) {
          onFile(event.dataTransfer.files[0]);
        }
      }}
    >
      <h3>{title}</h3>
      <p>Drag and drop or choose a file (.xlsx, .xlsm, .csv, .txt, .json)</p>
      <input
        type="file"
        accept={accept}
        onChange={(event) => onFile(event.target.files[0] || null)}
      />
      {file ? <div className="chosen">{file.name}</div> : null}
    </div>
  );
}

function CellModal({ value, onClose }) {
  if (value === null) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Cell value</h2>
        <pre>{value}</pre>
        <button className="btn-ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shared result controls                                              */
/* ------------------------------------------------------------------ */

function ColumnDropdown({ columns, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? columns.filter((column) => column.toLowerCase().includes(needle))
    : columns;

  const toggle = (column, checked) => {
    // Rebuild from `columns` so the chosen order always follows the file order.
    onChange(checked
      ? columns.filter((name) => selected.includes(name) || name === column)
      : selected.filter((name) => name !== column));
  };

  return (
    <div className="col-dd" ref={boxRef}>
      <button className="btn-ghost btn-small" onClick={() => setOpen(!open)}>
        Columns ({selected.length} of {columns.length}) {open ? "▴" : "▾"}
      </button>
      {open ? (
        <div className="col-dd-panel">
          <input type="search" placeholder="Find a column"
            value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="col-dd-tools">
            <button className="btn-ghost btn-small"
              onClick={() => onChange(columns.slice())}>Select all</button>
            <button className="btn-ghost btn-small"
              onClick={() => onChange([])}>Clear all</button>
          </div>
          <div className="col-dd-list">
            {visible.map((column) => (
              <label key={column}>
                <input type="checkbox" checked={selected.includes(column)}
                  onChange={(event) => toggle(column, event.target.checked)} />
                <span>{column}</span>
              </label>
            ))}
            {visible.length === 0 ? (
              <div className="col-dd-empty">No column matches that text.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PageSizeSelect({ value, onChange }) {
  return (
    <label className="page-size">
      Rows per page
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
  );
}

function Pager({ page, pages, total, onPage }) {
  return (
    <div className="pager">
      <button className="btn-ghost btn-small" disabled={page <= 1}
        onClick={() => onPage(page - 1)}>Previous</button>
      <span className="count">Page {page} of {pages} — {total} rows</span>
      <button className="btn-ghost btn-small" disabled={page >= pages}
        onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

/* Scrolls a cell into view inside its table and flashes an outline around it. */
function flashCell(element) {
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  element.classList.add("flash");
  setTimeout(() => element.classList.remove("flash"), 1400);
}

/* ------------------------------------------------------------------ */
/* record tabs (common / mismatches / duplicates)                      */
/* ------------------------------------------------------------------ */

function sideLabel(side) {
  return side === "right" ? "Right file" : "Left file";
}

function RecordTab({ tabId, records, columns, state, onState, executionId, onCell, showJump }) {
  const showSide = tabId === "duplicate";
  const selected = state.selectedColumns || columns;
  const cellRefs = useRef(new Map());
  const pendingJump = useRef(null);

  const filtered = useMemo(() => {
    const needle = state.query.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((record) =>
      cellText(record.key_norm).toLowerCase().includes(needle) ||
      (showSide && sideLabel(record.side).toLowerCase().includes(needle)) ||
      selected.some((column) => cellText(record.row[column]).toLowerCase().includes(needle))
    );
  }, [records, state.query, selected]);

  const sorted = useMemo(() => {
    if (!state.sortCol) return filtered;
    const rows = filtered.slice();
    rows.sort((a, b) => {
      const value = state.sortCol === "__key__"
        ? compareText(a.key_norm, b.key_norm)
        : state.sortCol === "__side__"
        ? compareText(sideLabel(a.side), sideLabel(b.side))
        : compareText(a.row[state.sortCol], b.row[state.sortCol]);
      return state.sortAsc ? value : -value;
    });
    return rows;
  }, [filtered, state.sortCol, state.sortAsc]);

  const pages = Math.max(1, Math.ceil(sorted.length / state.pageSize));
  const page = Math.min(state.page, pages);
  const start = (page - 1) * state.pageSize;
  const pageRows = sorted.slice(start, start + state.pageSize);

  // A jump may need a hidden column revealed first; finish it after that re-render.
  useEffect(() => {
    if (!pendingJump.current) return;
    const { rowKey, column } = pendingJump.current;
    pendingJump.current = null;
    flashCell(cellRefs.current.get(rowKey + "||" + column));
  });

  const jumpToDifference = (rowKey, record) => {
    const mismatch = record.mismatch_cols || [];
    if (!mismatch.length) return;
    const visible = mismatch.find((column) => selected.includes(column));
    if (visible) {
      flashCell(cellRefs.current.get(rowKey + "||" + visible));
      return;
    }
    onState({
      selectedColumns: columns.filter(
        (name) => selected.includes(name) || name === mismatch[0]),
    });
    pendingJump.current = { rowKey, column: mismatch[0] };
  };

  const exportCsv = () => {
    const header = ["Key"].concat(showSide ? ["Found in"] : [])
      .concat(selected).concat(["Info"]);
    const body = sorted.map((record) => [record.key_norm]
      .concat(showSide ? [sideLabel(record.side)] : [])
      .concat(selected.map((column) => cellText(record.row[column])))
      .concat([describeRecord(record)]));
    saveBlob(new Blob([toCsv([header].concat(body))], { type: "text/csv" }),
      tabId + "_" + executionId + ".csv");
  };

  const sortBy = (column) => {
    if (state.sortCol === column) onState({ sortAsc: !state.sortAsc });
    else onState({ sortCol: column, sortAsc: true });
  };

  return (
    <div>
      <div className="toolbar">
        <PageSizeSelect value={state.pageSize}
          onChange={(size) => onState({ pageSize: size, page: 1 })} />
        <input className="grow" type="search" placeholder="Search this tab"
          value={state.query}
          onChange={(event) => onState({ query: event.target.value, page: 1 })} />
        <ColumnDropdown columns={columns} selected={selected}
          onChange={(next) => onState({ selectedColumns: next, page: 1 })} />
        <span className="count">{sorted.length} rows</span>
        <span className="spacer" />
        <button className="btn-ghost btn-small" onClick={exportCsv}>Download CSV</button>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {showJump ? <th className="jump-col" title="Go to the difference"></th> : null}
              <th className="key-col sortable" onClick={() => sortBy("__key__")}
                title="Sort by the key these rows were matched on">Key</th>
              {showSide ? (
                <th className="side-col" onClick={() => sortBy("__side__")}>Found in</th>
              ) : null}
              {selected.map((column) => (
                <th key={column} onClick={() => sortBy(column)}>{column}</th>
              ))}
              <th>Info</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((record, index) => {
              const mismatch = record.mismatch_cols || [];
              const rowKey = "r" + (start + index);
              return (
                <tr key={rowKey}>
                  {showJump ? (
                    <td className="jump-col">
                      <button className="jump-btn" disabled={!mismatch.length}
                        title={mismatch.length
                          ? "Go to the first differing cell in this row"
                          : "This whole row has no counterpart on the other side"}
                        onClick={() => jumpToDifference(rowKey, record)}>&raquo;</button>
                    </td>
                  ) : null}
                  <td className="key-col">
                    <KeyPeek value={record.key_norm} />
                  </td>
                  {showSide ? (
                    <td className="side-col">
                      <span className={"side-pill " + (record.side === "right" ? "right" : "left")}>
                        {sideLabel(record.side)}
                      </span>
                    </td>
                  ) : null}
                  {selected.map((column) => {
                    const value = cellText(record.row[column]);
                    const classes = [];
                    if (record.is_missing) classes.push("missing");
                    else if (mismatch.includes(column)) classes.push("mismatch");
                    if (value.length > 50) classes.push("clickable");
                    return (
                      <td key={column} className={classes.join(" ")}
                        ref={(element) => {
                          const mapKey = rowKey + "||" + column;
                          if (element) cellRefs.current.set(mapKey, element);
                          else cellRefs.current.delete(mapKey);
                        }}
                        onClick={() => value.length > 50 && onCell(value)}>{value}</td>
                    );
                  })}
                  <td>
                    {describeRecord(record)}
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={selected.length + (showJump ? 3 : 2) + (showSide ? 1 : 0)}>
                  Nothing to show here — no rows fell into this category.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} total={sorted.length}
        onPage={(next) => onState({ page: next })} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* compare tab                                                         */
/* ------------------------------------------------------------------ */

/* The key can be a whole concatenated row, so it hides behind an icon you hover to read. */
function KeyPeek({ value }) {
  const text = cellText(value);
  return (
    <span className={"key-peek" + (text ? "" : " blank")}
          title={text || "(blank key)"}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="5.2" cy="5.2" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.5 7.5 L13.6 13.6 M11.2 11.2 L9.9 12.5 M13.6 13.6 L12.3 14.9"
              fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function CompareSide({ title, columns, labels, pageRows, side, onCell, query, onQuery,
                      wrapRef, onScroll, cellRefs, onJump }) {
  return (
    <div className="compare-pane">
      <div className="pane-head">
        <h3>{title}</h3>
        <input type="search" placeholder={"Search the " + title.toLowerCase()}
          value={query} onChange={(event) => onQuery(event.target.value)} />
      </div>
      <div className="table-wrap" ref={wrapRef} onScroll={onScroll}>
        <table className="data">
          <thead>
            <tr>
              <th className="jump-col" title="Go to the first difference in the row"></th>
              <th className="key-col" title="The key these two files are lined up on">Key</th>
              {columns.map((column) => <th key={column}>{labels[column] || column}</th>)}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, rowIndex) => {
              const payload = row[side];
              const missing = payload === null || payload === undefined;
              const mismatch = row.mismatch_cols || [];
              return (
                <tr key={side + row.key_norm + "#" + row.occurrence}>
                  <td className="jump-col">
                    <button className="jump-btn" disabled={!mismatch.length}
                      title={mismatch.length
                        ? "Go to the first differing cell in this row"
                        : "This row has no counterpart on the other side"}
                      onClick={() => onJump(rowIndex, row)}>&raquo;</button>
                  </td>
                  <td className="key-col">
                    <KeyPeek value={row.key_norm} />
                  </td>
                  {columns.map((column) => {
                    const value = missing ? "" : cellText(payload[column]);
                    const classes = [];
                    if (missing) classes.push("missing");
                    else if (mismatch.includes(column)) classes.push("mismatch");
                    if (value.length > 50) classes.push("clickable");
                    return (
                      <td key={column} className={classes.join(" ")}
                        ref={(element) => {
                          const mapKey = side + "||" + rowIndex + "||" + column;
                          if (element) cellRefs.current.set(mapKey, element);
                          else cellRefs.current.delete(mapKey);
                        }}
                        onClick={() => value.length > 50 && onCell(value)}>{value}</td>
                    );
                  })}
                </tr>
              );
            })}
            {pageRows.length === 0 ? (
              <tr><td colSpan={columns.length + 2}>No differing rows to display.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareTab({ rows, columns, labels, state, onState, executionId, onCell, onError }) {
  const [sortOpen, setSortOpen] = useState(false);
  const leftWrap = useRef(null);
  const rightWrap = useRef(null);
  const mirroring = useRef(false);

  /* Scrolling either table moves the other so paired rows and columns stay lined up.
     The flag stops the mirrored scroll from bouncing straight back. */
  const cellRefs = useRef(new Map());
  const pendingJump = useRef(null);

  const mirrorScroll = (fromRef, toRef) => {
    const source = fromRef.current;
    const target = toRef.current;
    if (!source || !target || mirroring.current) return;
    mirroring.current = true;
    target.scrollLeft = source.scrollLeft;
    target.scrollTop = source.scrollTop;
    window.requestAnimationFrame(() => { mirroring.current = false; });
  };
  // No fall-back to every column: clearing the picker must really show no columns.
  const active = (state.selectedColumns || columns).filter((name) => columns.includes(name));

  const matchesSide = (payload, needle) => {
    if (!needle) return true;
    if (!payload) return false;
    return active.some((column) => cellText(payload[column]).toLowerCase().includes(needle));
  };

  const filtered = useMemo(() => {
    const left = state.leftQuery.trim().toLowerCase();
    const right = state.rightQuery.trim().toLowerCase();
    if (!left && !right) return rows;
    // Both inputs stay independent; with text in both, a row must satisfy each side.
    return rows.filter((row) =>
      (!left || matchesSide(row.left, left)) && (!right || matchesSide(row.right, right)));
  }, [rows, state.leftQuery, state.rightQuery, active.join("|")]);

  const applied = state.appliedSortLevels || [];
  const appliedKey = JSON.stringify(applied);

  const sorted = useMemo(() => {
    const levels = applied.filter((level) => level.column);
    const data = filtered.slice();
    const pick = (payload, column) => (payload ? payload[column] : undefined);
    // One comparator over aligned rows keeps both tables in the same order.
    data.sort((a, b) => {
      for (const level of levels) {
        const direction = level.asc ? 1 : -1;
        const aValue = pick(a.left, level.column) ?? pick(a.right, level.column) ?? "";
        const bValue = pick(b.left, level.column) ?? pick(b.right, level.column) ?? "";
        const result = compareText(aValue, bValue);
        if (result !== 0) return result * direction;
      }
      const aBlank = a.key_norm === "" ? 1 : 0;
      const bBlank = b.key_norm === "" ? 1 : 0;
      if (aBlank !== bBlank) return aBlank - bBlank;
      const byKey = compareText(a.key_norm, b.key_norm);
      if (byKey !== 0) return byKey;
      return a.occurrence - b.occurrence;
    });
    return data;
  }, [filtered, appliedKey]);

  const pages = Math.max(1, Math.ceil(sorted.length / state.pageSize));
  const page = Math.min(state.page, pages);
  const start = (page - 1) * state.pageSize;
  const pageRows = sorted.slice(start, start + state.pageSize);

  // Always show one sort row so the control is visible before anything is added.
  const levels = state.sortLevels || [];
  const editing = levels.length ? levels : [{ column: "", asc: true }];
  const dirty = JSON.stringify(levels.filter((level) => level.column)) !== appliedKey;

  const setLevels = (next) => onState({ sortLevels: next });
  const updateLevel = (index, changes) => {
    const next = editing.map((level, position) =>
      (position === index ? { ...level, ...changes } : level));
    setLevels(next.filter((level) => level.column));
  };

  const exportCsv = () => {
    const header = active.concat([""]).concat(active.map((c) => labels[c] || c));
    const body = sorted.map((row) =>
      active.map((column) => (row.left ? cellText(row.left[column]) : ""))
        .concat([""])
        .concat(active.map((column) => (row.right ? cellText(row.right[column]) : ""))));
    saveBlob(new Blob([toCsv([header].concat(body))], { type: "text/csv" }),
      "compare_" + executionId + ".csv");
  };

  const flashPair = (rowIndex, column) => {
    const left = cellRefs.current.get("left||" + rowIndex + "||" + column);
    const right = cellRefs.current.get("right||" + rowIndex + "||" + column);
    const anchor = left || right;
    const wrap = left ? leftWrap.current : rightWrap.current;

    if (anchor && wrap) {
      // Both panes are moved directly and instantly. scrollIntoView's smooth animation
      // cannot be used here: each pane mirrors the other, and the mirrored write
      // interrupts the animation, leaving it stranded part way.
      const cellBox = anchor.getBoundingClientRect();
      const wrapBox = wrap.getBoundingClientRect();
      const centred = wrap.scrollLeft + (cellBox.left - wrapBox.left)
        - (wrap.clientWidth - cellBox.width) / 2;
      const x = Math.max(0, Math.min(centred, wrap.scrollWidth - wrap.clientWidth));

      let y = wrap.scrollTop;
      const above = cellBox.top - wrapBox.top;
      if (above < 0 || above + cellBox.height > wrap.clientHeight) {
        y = Math.max(0, Math.min(wrap.scrollTop + above - wrap.clientHeight / 2,
                                 wrap.scrollHeight - wrap.clientHeight));
      }

      mirroring.current = true;
      [leftWrap.current, rightWrap.current].forEach((pane) => {
        if (!pane) return;
        pane.scrollLeft = x;
        pane.scrollTop = y;
      });
      window.requestAnimationFrame(() => { mirroring.current = false; });
    }

    [left, right].forEach((cell) => {
      if (!cell) return;
      cell.classList.add("flash");
      setTimeout(() => cell.classList.remove("flash"), 1400);
    });
  };

  // A jump may first need a hidden column put back; finish it after that re-render.
  useEffect(() => {
    if (!pendingJump.current) return;
    const { rowIndex, column } = pendingJump.current;
    pendingJump.current = null;
    flashPair(rowIndex, column);
  });

  const jumpToDifference = (rowIndex, row) => {
    const mismatch = row.mismatch_cols || [];
    if (!mismatch.length) return;
    const visible = mismatch.find((column) => active.includes(column));
    if (visible) {
      flashPair(rowIndex, visible);
      return;
    }
    onState({
      selectedColumns: columns.filter(
        (name) => active.includes(name) || name === mismatch[0]),
    });
    pendingJump.current = { rowIndex, column: mismatch[0] };
  };

  const sortBadge = dirty ? (
    <span className="sort-dirty">Not applied yet — press Apply sort</span>
  ) : applied.length ? (
    <span className="sort-applied">
      Sorted by {applied.map((level) => level.column).join(", then ")}
    </span>
  ) : null;

  return (
    <div>
      <div className="toolbar">
        <PageSizeSelect value={state.pageSize}
          onChange={(size) => onState({ pageSize: size, page: 1 })} />
        <ColumnDropdown columns={columns} selected={active}
          onChange={(next) => onState({ selectedColumns: next, page: 1 })} />
        <button className={"btn-ghost btn-small" + (sortOpen ? " toggled" : "")}
          onClick={() => setSortOpen(!sortOpen)}>
          Sort {sortOpen ? "\u25B4" : "\u25BE"}
        </button>
        {sortBadge}
        <span className="count">{sorted.length} rows with differences</span>
        <span className="spacer" />
        <button className="btn-ghost btn-small" onClick={exportCsv}>Download CSV</button>
      </div>

      {sortOpen ? (
      <div className="panel">
        <h4>Sort both tables</h4>
        <p className="panel-hint">
          Both tables always move together, so matching records stay side by side. Choose a
          column, add more columns to break ties, then press Apply sort.
        </p>
        {editing.map((level, index) => (
          <div className="sort-row" key={index}>
            <span className="sort-label">{index === 0 ? "Sort by" : "Then by"}</span>
            <select value={level.column}
              onChange={(event) => updateLevel(index, { column: event.target.value })}>
              <option value="">Choose a column…</option>
              {columns.map((column) => (
                <option key={column} value={column}>{column}</option>
              ))}
            </select>
            <select value={level.asc ? "asc" : "desc"}
              onChange={(event) => updateLevel(index, { asc: event.target.value === "asc" })}>
              <option value="asc">A to Z / smallest first</option>
              <option value="desc">Z to A / largest first</option>
            </select>
            <button className="btn-ghost btn-small" disabled={!levels.length}
              onClick={() => setLevels(levels.filter((_, position) => position !== index))}>
              Remove
            </button>
          </div>
        ))}
        <div className="sort-actions">
          <button className="btn-ghost btn-small"
            disabled={!levels.length || levels.length >= columns.length}
            onClick={() => setLevels(levels.concat([{ column: "", asc: true }]))}>
            Add another column
          </button>
          <button className="btn-primary btn-small" disabled={!dirty}
            onClick={() => onState({
              appliedSortLevels: levels.filter((level) => level.column), page: 1,
            })}>
            Apply sort
          </button>
          <button className="btn-ghost btn-small" disabled={!levels.length && !applied.length}
            onClick={() => onState({ sortLevels: [], appliedSortLevels: [], page: 1 })}>
            Clear sorting
          </button>
          {applied.length || dirty ? null : (
            <span className="count">Rows follow the order of the key columns.</span>
          )}
        </div>
      </div>
      ) : null}

      <div className="compare-grid">
        <CompareSide title="Left file" columns={active} labels={{}}
          pageRows={pageRows} side="left" onCell={onCell}
          query={state.leftQuery}
          onQuery={(value) => onState({ leftQuery: value, page: 1 })}
          wrapRef={leftWrap}
          onScroll={() => mirrorScroll(leftWrap, rightWrap)}
          cellRefs={cellRefs} onJump={jumpToDifference} />
        <CompareSide title="Right file" columns={active} labels={labels}
          pageRows={pageRows} side="right" onCell={onCell}
          query={state.rightQuery}
          onQuery={(value) => onState({ rightQuery: value, page: 1 })}
          wrapRef={rightWrap}
          onScroll={() => mirrorScroll(rightWrap, leftWrap)}
          cellRefs={cellRefs} onJump={jumpToDifference} />
      </div>

      <Pager page={page} pages={pages} total={sorted.length}
        onPage={(next) => onState({ page: next })} />
    </div>
  );
}

/* A short label for a row when its key is not readable (whole-row keys). */
function rowLabel(record, columns) {
  for (const column of columns) {
    const value = cellText(record.row[column]);
    if (value) return column + " " + value;
  }
  return "(blank row)";
}

function differingColumns(left, right, columns) {
  return columns.filter((column) =>
    cellText(left.row[column]) !== cellText(right.row[column]));
}

/* How much two rows look alike, ignoring columns blank on both sides. */
function rowSimilarity(left, right, columns) {
  let same = 0;
  let counted = 0;
  columns.forEach((column) => {
    const a = cellText(left.row[column]);
    const b = cellText(right.row[column]);
    if (a === "" && b === "") return;
    counted += 1;
    if (a === b) same += 1;
  });
  return counted ? same / counted : 0;
}

/* When the key is the whole row, an edit lands as one left-only and one right-only
   record with different keys, so nothing pairs up by key. Match those leftovers to
   their closest counterpart instead, and report the rest as added or removed. */
function pairLeftovers(leftOnly, rightOnly, columns) {
  const takenRight = new Set();
  const paired = [];
  const removed = [];
  leftOnly.forEach((left) => {
    let bestIndex = -1;
    let bestScore = 0;
    rightOnly.forEach((right, index) => {
      if (takenRight.has(index)) return;
      const score = rowSimilarity(left, right, columns);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestScore >= 0.5) {
      takenRight.add(bestIndex);
      paired.push({ left: left, right: rightOnly[bestIndex], approximate: true });
    } else {
      removed.push(left);
    }
  });
  const added = rightOnly.filter((_, index) => !takenRight.has(index));
  return { paired: paired, removed: removed, added: added };
}

function ChangeList({ pair, columns }) {
  const changed = pair.approximate
    ? differingColumns(pair.left, pair.right, columns)
    : (pair.left.mismatch_cols || []);
  return (
    <React.Fragment>
      {changed.map((column, position) => (
        <React.Fragment key={column}>
          {position > 0 ? "; " : ""}
          <span className="val-col">{column}</span> is{" "}
          <span className="val-old">{cellText(pair.left.row[column]) || "(blank)"}</span>
          <span className="val-side"> in the left file</span> but{" "}
          <span className="val-new">{cellText(pair.right.row[column]) || "(blank)"}</span>
          <span className="val-side"> in the right file</span>
        </React.Fragment>
      ))}
      {changed.length === 0 ? "no column differs" : null}.
    </React.Fragment>
  );
}

/* Keeps the count inside its coloured chip while the wording around it agrees in number. */
function Stat({ value, tone, one, many }) {
  return (
    <React.Fragment>
      <span className={"stat " + tone}>{value}</span> {value === 1 ? one : many}
    </React.Fragment>
  );
}

function SummaryTab({ results, summary }) {
  const columns = results.comparable_columns || results.columns || [];

  const { keyed, paired, removed, added } = useMemo(() => {
    const first = results.mismatch_first || [];
    const second = results.mismatch_second || [];

    const rightByKey = new Map();
    second.forEach((record) => {
      if (!record.is_missing) rightByKey.set(record.key_norm, record);
    });
    const keyedPairs = first
      .filter((record) => !record.is_missing)
      .map((record) => ({ left: record, right: rightByKey.get(record.key_norm) }))
      .filter((pair) => pair.right);

    const leftovers = pairLeftovers(
      first.filter((record) => record.is_missing),
      second.filter((record) => record.is_missing),
      columns);

    return {
      keyed: keyedPairs,
      paired: leftovers.paired,
      removed: leftovers.removed,
      added: leftovers.added,
    };
  }, [results, columns.join("|")]);

  const changes = keyed.concat(paired);
  const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");

  return (
    <div className="summary-text">
      <p>
        Comparing the two files,{" "}
        <Stat value={summary ? summary.common_count : 0} tone="ok"
          one="row matches on every compared value"
          many="rows match on every compared value" />,{" "}
        <Stat value={changes.length} tone="warn"
          one="row exists in both files but holds different values"
          many="rows exist in both files but hold different values" />,{" "}
        <Stat value={removed.length} tone="bad"
          one="row is in the left file only" many="rows are in the left file only" />,{" "}
        <Stat value={added.length} tone="bad"
          one="row is in the right file only" many="rows are in the right file only" />, and{" "}
        <Stat value={summary ? summary.duplicate_key_count : 0} tone="info"
          one="key appears more than once within a single file"
          many="keys appear more than once within a single file" />.
      </p>

      {paired.length ? (
        <p className="summary-note">
          The whole row is being used as the key, so edited rows do not pair up on their own.
          The {plural(paired.length, "change")} below {paired.length === 1 ? "was" : "were"}{" "}
          worked out by matching each row to its closest counterpart in the other file.
        </p>
      ) : null}

      <h3>Rows that exist in both files but hold different values</h3>
      <ul>
        {changes.slice(0, 200).map((pair, index) => (
          <li key={index}>
            {"For the row where "}
            {pair.approximate ? (
              <span className="val-key">{rowLabel(pair.left, columns)}</span>
            ) : (
              <React.Fragment>
                the key is <span className="val-key">{pair.left.key_norm || "(blank)"}</span>
              </React.Fragment>
            )}
            {": "}
            <ChangeList pair={pair} columns={columns} />
          </li>
        ))}
        {changes.length === 0 ? (
          <li>No rows were found that exist in both files with differing values.</li>
        ) : null}
      </ul>
      {changes.length > 200 ? (
        <p className="count">Showing the first 200 changed rows.</p>
      ) : null}

      {removed.length ? (
        <React.Fragment>
          <h3>Rows found only in the left file</h3>
          <ul>
            {removed.slice(0, 100).map((record, index) => (
              <li key={index}>
                {"The row where "}
                <span className="val-old">{rowLabel(record, columns)}</span>
                {" is in the left file, but there is no matching row in the right file."}
              </li>
            ))}
          </ul>
        </React.Fragment>
      ) : null}

      {added.length ? (
        <React.Fragment>
          <h3>Rows found only in the right file</h3>
          <ul>
            {added.slice(0, 100).map((record, index) => (
              <li key={index}>
                {"The row where "}
                <span className="val-new">{rowLabel(record, columns)}</span>
                {" is in the right file, but there is no matching row in the left file."}
              </li>
            ))}
          </ul>
        </React.Fragment>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

function Results({ results, summary, executionId, activeTab, setActiveTab, tabState, setTabState,
                   onError }) {
  const [modalValue, setModalValue] = useState(null);
  const columns = results.columns || [];
  const comparable = results.comparable_columns || [];
  const labels = results.right_labels || {};
  const keys = results.primary_keys || [];
  const compareRows = useMemo(
    () => (results.compare || []).filter(hasDifference), [results.compare]);
  const state = tabState[activeTab] || emptyTabState();
  const patch = (changes) => setTabState(activeTab, changes);
  const tab = TABS.find((item) => item.id === activeTab) || TABS[0];

  // Basic Compare uses every comparable column as the key, which is a whole-row check.
  const wholeRow = keys.length === 0 || (comparable.length > 0 && keys.length >= comparable.length);

  const counts = {
    common: (results.common || []).length,
    mismatch_first: (results.mismatch_first || []).length,
    mismatch_second: (results.mismatch_second || []).length,
    duplicate: (results.duplicate || []).length,
    compare: compareRows.length,
  };

  const downloadExcel = async () => {
    try {
      const blob = await apiBlob("/api/executions/" + executionId + "/download/excel");
      saveBlob(blob, "comparison_" + executionId + ".xlsx");
    } catch (error) {
      onError(error.message);
    }
  };

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <div className="results-head">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <h2 className="grow" style={{ margin: 0 }}>Results</h2>
          <button className="btn-primary btn-small" onClick={downloadExcel}>
            Download Excel workbook
          </button>
        </div>
        <div className="key-basis">
          {wholeRow ? (
            <React.Fragment>
              <strong>Row by row validation.</strong> No separate key column was chosen, so the
              whole row acts as the key — a row counts as matched only when every compared value
              is identical.
            </React.Fragment>
          ) : (
            <React.Fragment>
              <strong>
                Rows were matched on {keys.length === 1 ? "this key column" : "these key columns"}:
              </strong>{" "}
              {keys.map((key) => <span className="key-chip" key={key}>{key}</span>)}
              <span> — every other column is then compared value by value.</span>
            </React.Fragment>
          )}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.id} className={"tab" + (activeTab === item.id ? " active" : "")}
            onClick={() => setActiveTab(item.id)}>
            {item.label}
            {counts[item.id] === undefined
              ? null
              : <span className="tab-count">{counts[item.id]}</span>}
          </button>
        ))}
      </div>

      <p className="tab-blurb">{tab.blurb}</p>

      {activeTab === "compare" ? (
        <CompareTab rows={compareRows} columns={comparable} labels={labels}
          state={state} onState={patch} executionId={executionId}
          onCell={setModalValue} onError={onError} />
      ) : activeTab === "summary" ? (
        <SummaryTab results={results} summary={summary} />
      ) : (
        <RecordTab tabId={activeTab} records={results[activeTab] || []} columns={columns}
          state={state} onState={patch} executionId={executionId} onCell={setModalValue}
          showJump={activeTab === "mismatch_first" || activeTab === "mismatch_second"} />
      )}

      <CellModal value={modalValue} onClose={() => setModalValue(null)} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* map columns                                                         */
/* ------------------------------------------------------------------ */

function normalizeHeader(name) {
  return String(name === null || name === undefined ? "" : name).replace(/\s+/g, "").toLowerCase();
}

/* Seed the rows from the automatic name match; the user rearranges from there. */
function buildPairs(leftColumns, rightColumns, matches) {
  const usedRight = new Set();
  const rows = (leftColumns || []).map((name) => {
    const match = (matches || []).find((item) => item.left_name === name);
    const right = match && match.right_name ? match.right_name : null;
    if (right) usedRight.add(right);
    return { left: name, right: right };
  });
  (rightColumns || []).forEach((name) => {
    if (!usedRight.has(name)) rows.push({ left: null, right: name });
  });
  return rows;
}

function pairStatus(row) {
  if (!row.left || !row.right) return { tag: "missing", label: "not paired" };
  if (normalizeHeader(row.left) === normalizeHeader(row.right)) {
    return { tag: "matched", label: "same name" };
  }
  return { tag: "partial", label: "paired by you" };
}

function MapSlot({ side, index, value, onPick, onDropAt, isDragging, isOver }) {
  const classes = ["map-slot"];
  if (!value) classes.push("blank");
  if (isDragging) classes.push("dragging");
  if (isOver) classes.push("over");
  return (
    <div
      className={classes.join(" ")}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without payload.
        event.dataTransfer.setData("text/plain", String(index));
        onPick(side, index);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDropAt(side, index, false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropAt(side, index, true);
      }}
    >
      <span className="grip" aria-hidden="true">⠿</span>
      <span className="map-name">{value || "— blank —"}</span>
    </div>
  );
}

function MapColumns({ pairs, setPairs, primaryKeys, setPrimaryKeys, busy, onSave }) {
  const drag = useRef(null);
  const [over, setOver] = useState(null);

  const leftNames = pairs.map((row) => row.left).filter(Boolean);
  const allChecked = leftNames.length > 0 && leftNames.every((name) => primaryKeys.includes(name));

  const move = (side, from, to) => {
    if (from === to) return;
    const values = pairs.map((row) => row[side]);
    const [picked] = values.splice(from, 1);
    values.splice(to, 0, picked);
    setPairs(pairs.map((row, index) => ({ ...row, [side]: values[index] })));
  };

  const onDropAt = (side, index, commit) => {
    const source = drag.current;
    if (!source || source.side !== side) return;
    if (!commit) {
      setOver({ side: side, index: index });
      return;
    }
    move(side, source.index, index);
    drag.current = null;
    setOver(null);
  };

  const toggleKey = (name, checked) => {
    setPrimaryKeys(checked
      ? leftNames.filter((item) => primaryKeys.includes(item) || item === name)
      : primaryKeys.filter((item) => item !== name));
  };

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <h2>Map columns</h2>
      <p className="hint">
        Each row pairs one column from the left file with one from the right file. Drag a name
        up or down its own side to line it up against a different row, leaving a blank opposite
        a column that has no counterpart. Tick the columns that together identify a row.
      </p>

      <div className="map-grid" onDragEnd={() => { drag.current = null; setOver(null); }}>
        <div className="map-head">
          <label className="map-key-head" title="Use every column as the key">
            <input type="checkbox" checked={allChecked}
              onChange={(event) => setPrimaryKeys(event.target.checked ? leftNames.slice() : [])} />
            Key
          </label>
          <div>Left file columns</div>
          <div className="map-divider" />
          <div>Right file columns</div>
          <div>Pairing</div>
          <div />
        </div>

        <div className="map-rows">
          {pairs.map((row, index) => {
            const status = pairStatus(row);
            return (
              <div className="map-row" key={index}>
                <input type="checkbox" disabled={!row.left}
                  checked={!!row.left && primaryKeys.includes(row.left)}
                  onChange={(event) => toggleKey(row.left, event.target.checked)} />
                <MapSlot side="left" index={index} value={row.left}
                  onPick={(side, position) => { drag.current = { side, index: position }; }}
                  onDropAt={onDropAt}
                  isDragging={!!drag.current && drag.current.side === "left"
                    && drag.current.index === index}
                  isOver={!!over && over.side === "left" && over.index === index} />
                <div className="map-divider" />
                <MapSlot side="right" index={index} value={row.right}
                  onPick={(side, position) => { drag.current = { side, index: position }; }}
                  onDropAt={onDropAt}
                  isDragging={!!drag.current && drag.current.side === "right"
                    && drag.current.index === index}
                  isOver={!!over && over.side === "right" && over.index === index} />
                <span className={"status-tag status-" + status.tag}>{status.label}</span>
                <button className="icon-btn" title="Remove this empty row"
                  disabled={!!row.left || !!row.right}
                  onClick={() => setPairs(pairs.filter((_, i) => i !== index))}>&times;</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="actions">
        <button className="btn-ghost"
          onClick={() => setPairs(pairs.concat([{ left: null, right: null }]))}>
          Add blank row
        </button>
        <button className="btn-primary" onClick={onSave} disabled={busy}>
          <Busy label="Save mapping" busy={busy} />
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* feedback                                                            */
/* ------------------------------------------------------------------ */

const FEEDBACK_EMAIL = "pradipta.7845@gmail.com";
const FEEDBACK_CATEGORIES = ["Suggestion", "Bug or problem", "Question"];

function FeedbackDialog({ onClose }) {
  const [category, setCategory] = useState(FEEDBACK_CATEGORIES[0]);
  const [message, setMessage] = useState("");
  const boxRef = useRef(null);

  useEffect(() => {
    if (boxRef.current) boxRef.current.focus();
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A real mailto link rather than a scripted navigation: the browser hands it to whatever
  // mail client is registered, and right-click / copy-address still work.
  const canSend = message.trim().length > 0;
  const mailtoHref = "mailto:" + FEEDBACK_EMAIL
    + "?subject=" + encodeURIComponent("[Data Compare Utility] " + category)
    + "&body=" + encodeURIComponent(message + "\n\n---\nSent from the Data Compare Utility.");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(event) => event.stopPropagation()}>
        <h2>Tell us what you think</h2>
        <p className="hint">
          What worked well, what got in your way, or what you would like this tool to do next —
          every note helps. <strong>Pradipta will receive your feedback</strong> and use it for
          further changes and upgradations.
        </p>

        <label className="field">
          What kind of feedback is this?
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {FEEDBACK_CATEGORIES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>

        <label className="field" style={{ marginTop: 14 }}>
          Your message
          <textarea ref={boxRef} rows={8} value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Share your thoughts, ideas or anything that slowed you down…" />
        </label>

        <div className="actions">
          <a className={"btn-link btn-primary" + (canSend ? "" : " is-disabled")}
            href={canSend ? mailtoHref : undefined}
            aria-disabled={!canSend}
            onClick={(event) => {
              if (!canSend) { event.preventDefault(); return; }
              // Stored first so the note survives even if the mail is never sent.
              api("/api/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category: category, message: message }),
              }).catch(() => {});
              onClose();
            }}>
            Send to Pradipta
          </a>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
        <p className="count" style={{ marginTop: 10 }}>
          Your note is saved here as well, so it can be exported later even if your mail client
          does not open.
        </p>
      </div>
    </div>
  );
}

function todayIso() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
}

function ExportFeedbackDialog({ onClose }) {
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await apiBlob(
        "/api/feedback/export?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to));
      saveBlob(blob, "feedback_" + from + "_to_" + to + ".txt");
      onClose();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(event) => event.stopPropagation()}>
        <h2>Export feedback</h2>
        <p className="hint">
          Download everything people have written over a period as a text file, then send that
          file on by email.
        </p>
        <div className="field-grid">
          <label className="field">
            From date
            <input type="date" value={from} max={to}
              onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            To date
            <input type="date" value={to} min={from}
              onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        {error ? <p className="notice error" style={{ marginTop: 14 }}>{error}</p> : null}
        <div className="actions">
          <button className="btn-primary" disabled={busy} onClick={download}>
            <Busy label={busy ? "Preparing…" : "Download .txt"} busy={busy} />
          </button>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function FeedbackBar({ counts, onOpen, onExport }) {
  return (
    <footer className="footer-bar">
      <span className="usage">
        <span className="usage-item">
          <strong>{counts ? counts.opens : "—"}</strong>
          {counts && counts.opens === 1 ? " time opened" : " times opened"}
        </span>
        <span className="usage-item">
          <strong>{counts ? counts.comparisons : "—"}</strong>
          {counts && counts.comparisons === 1 ? " comparison run" : " comparisons run"}
        </span>
      </span>
      <span className="footer-spacer" />
      <button className="btn-ghost btn-small" title="Export feedback for a date range"
        onClick={onExport}>
        <span aria-hidden="true">&#8681;</span> Export
      </button>
      <button className="btn-primary btn-small" onClick={onOpen}>
        <span aria-hidden="true">&#9998;</span> Feedback &amp; suggest
      </button>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

function App() {
  const [executions, setExecutions] = useState([]);
  const [executionId, setExecutionId] = useState(null);
  const [step, setStep] = useState(1);
  const [leftFile, setLeftFile] = useState(null);
  const [rightFile, setRightFile] = useState(null);
  const [leftSheets, setLeftSheets] = useState([]);
  const [rightSheets, setRightSheets] = useState([]);
  const [leftSheet, setLeftSheet] = useState("");
  const [rightSheet, setRightSheet] = useState("");
  const [matches, setMatches] = useState([]);
  const [pairs, setPairs] = useState([]);
  const [primaryKeys, setPrimaryKeys] = useState([]);
  const [rules, setRules] = useState(null);
  const [validation, setValidation] = useState(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [counts, setCounts] = useState(null);
  const [results, setResults] = useState(null);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [activeTab, setActiveTab] = useState("compare");
  const [tabState, setTabStateAll] = useState(() => {
    const initial = {};
    TABS.forEach((tab) => { initial[tab.id] = emptyTabState(); });
    return initial;
  });
  const [busyAction, setBusyAction] = useState(null);
  const [progress, setProgress] = useState(null);
  const pollRef = useRef(null);

  const setTabState = useCallback((tabId, changes) => {
    setTabStateAll((current) => ({ ...current, [tabId]: { ...current[tabId], ...changes } }));
  }, []);

  const loadExecutions = useCallback(async () => {
    try {
      const data = await api("/api/executions");
      setExecutions(data.executions || []);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }, []);

  useEffect(() => { loadExecutions(); }, [loadExecutions]);

  // One count per page load; the reply carries the fresh totals for the footer.
  useEffect(() => {
    api("/api/analytics/open", { method: "POST" })
      .then(setCounts)
      .catch(() => {});
  }, []);

  const refreshCounts = useCallback(() => {
    api("/api/analytics").then(setCounts).catch(() => {});
  }, []);

  const startProgress = (operationId) => {
    setProgress({ percent: 0, status: "Waiting to start" });
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const state = await api("/api/progress/" + operationId);
        setProgress(state);
      } catch (error) {
        /* keep the last known progress */
      }
    }, 400);
  };

  const stopProgress = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setTimeout(() => setProgress(null), 600);
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const resetTabs = () => {
    const fresh = {};
    TABS.forEach((tab) => { fresh[tab.id] = emptyTabState(); });
    setTabStateAll(fresh);
    setActiveTab("compare");
  };

  const loadResults = async (id) => {
    const data = await api("/api/executions/" + id + "/results");
    setResults(data);
    setSummary(data.summary);
    setMatches(data.matches || []);
    return data;
  };

  const runBasic = async () => {
    if (!leftFile || !rightFile) {
      setErrorMessage("Choose a left file and a right file first.");
      return;
    }
    const operationId = newOperationId();
    setBusyAction("basic");
    setErrorMessage(null);
    startProgress(operationId);
    try {
      const form = new FormData();
      form.append("left_file", leftFile);
      form.append("right_file", rightFile);
      form.append("operation_id", operationId);
      const data = await api("/api/executions/basic", { method: "POST", body: form });
      setExecutionId(data.execution_id);
      setLeftSheets(data.left_sheets || []);
      setRightSheets(data.right_sheets || []);
      setLeftSheet(data.left_sheet);
      setRightSheet(data.right_sheet);
      setMatches(data.matches);
      setPairs(buildPairs(data.left_columns, data.right_columns, data.matches));
      setPrimaryKeys(data.primary_keys);
      setRules(data.rules);
      setValidation(data.validation);
      setSummary(data.summary);
      resetTabs();
      await loadResults(data.execution_id);
      setStep(7);
      setMessage("Basic Compare completed. Review the results below.");
      loadExecutions();
      refreshCounts();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setBusyAction(null);
      stopProgress();
    }
  };

  const runAdvancedUpload = async () => {
    if (!leftFile || !rightFile) {
      setErrorMessage("Choose a left file and a right file first.");
      return;
    }
    const operationId = newOperationId();
    setBusyAction("advanced");
    setErrorMessage(null);
    startProgress(operationId);
    try {
      const form = new FormData();
      form.append("left_file", leftFile);
      form.append("right_file", rightFile);
      form.append("operation_id", operationId);
      const data = await api("/api/executions", { method: "POST", body: form });
      setExecutionId(data.execution_id);
      setLeftSheets(data.left_sheets);
      setRightSheets(data.right_sheets);
      setLeftSheet(data.left_sheets[0] || "");
      setRightSheet(data.right_sheets[0] || "");
      setMatches([]);
      setPrimaryKeys([]);
      setRules(data.execution.rules);
      setValidation(null);
      setResults(null);
      setSummary(null);
      setSettingsOpen(false);
      resetTabs();
      setStep(3);
      setMessage("Upload completed. Continue with the Advanced Compare steps below.");
      loadExecutions();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setBusyAction(null);
      stopProgress();
    }
  };

  const saveSheets = async () => {
    setBusyAction("sheets");
    setErrorMessage(null);
    try {
      const data = await api("/api/executions/" + executionId + "/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ left_sheet: leftSheet, right_sheet: rightSheet }),
      });
      setMatches(data.matches);
      setPairs(buildPairs(data.left_columns, data.right_columns, data.matches));
      setPrimaryKeys(data.left_columns.slice(0, 1));
      setStep(4);
      setMessage("Sheets saved. Map the columns and choose the primary keys.");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setBusyAction(null);
    }
  };

  const saveMapping = async (nextStep) => {
    setBusyAction("mapping");
    setErrorMessage(null);
    try {
      const data = await api("/api/executions/" + executionId + "/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          column_pairs: pairs.map((row) => [row.left, row.right]),
          primary_keys: primaryKeys,
          rules: rules,
        }),
      });
      setMatches(data.matches);
      setRules(data.rules);
      setValidation(data.validation);
      setStep(nextStep);
      setMessage(nextStep === 6 ? "Rules saved. Review the validation summary." : "Mapping saved.");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setBusyAction(null);
    }
  };

  const refreshValidation = async () => {
    setBusyAction("validation");
    try {
      const data = await api("/api/executions/" + executionId + "/validation");
      setValidation(data);
      setValidationOpen(true);
      setStep(6);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setBusyAction(null);
    }
  };

  const runCompare = async () => {
    const operationId = newOperationId();
    setBusyAction("compare");
    setErrorMessage(null);
    startProgress(operationId);
    try {
      const data = await api("/api/executions/" + executionId + "/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: operationId }),
      });
      setSummary(data.summary);
      setValidation(data.validation);
      resetTabs();
      await loadResults(executionId);
      setStep(7);
      setMessage("Comparison completed. Review the results below.");
      loadExecutions();
      refreshCounts();
    } catch (error) {
      setErrorMessage(error.message);
      if (error.payload && error.payload.validation) {
        setValidation(error.payload.validation);
        setValidationOpen(true);
      }
    } finally {
      setBusyAction(null);
      stopProgress();
    }
  };

  const resume = async (id) => {
    setErrorMessage(null);
    try {
      const data = await api("/api/executions/" + id);
      setExecutionId(id);
      setLeftSheets(data.left_sheets || []);
      setRightSheets(data.right_sheets || []);
      setLeftSheet(data.left_sheet || (data.left_sheets || [])[0] || "");
      setRightSheet(data.right_sheet || (data.right_sheets || [])[0] || "");
      setMatches(data.matches || []);
      setPairs((data.column_pairs || []).length
        ? data.column_pairs.map((pair) => ({ left: pair[0] || null, right: pair[1] || null }))
        : buildPairs(data.left_columns || [], data.right_columns || [], data.matches || []));
      setPrimaryKeys(data.primary_keys || []);
      setRules(data.rules);
      setSummary(data.summary);
      setValidation(null);
      resetTabs();
      if (data.status === "completed" || data.current_step >= 7) {
        await loadResults(id);
        setStep(7);
        setMessage("Resumed a completed comparison.");
      } else {
        setResults(null);
        setStep(Math.max(3, data.current_step));
        setMessage("Resumed execution " + id + ".");
      }
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const remove = async (id) => {
    try {
      await api("/api/executions/" + id, { method: "DELETE" });
      if (id === executionId) {
        setExecutionId(null);
        setResults(null);
        setStep(1);
      }
      loadExecutions();
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  // Tied to the results themselves, not the step, so saving a setting mid-edit does not
  // yank the results and the ribbon out from under the user.
  const completed = !!results;
  const showAdvanced = !!executionId && (!completed || settingsOpen);

  return (
    <div className="shell">
      <Masthead />
      <Stepper step={step} />

      {errorMessage ? <div className="notice error">{errorMessage}</div> : null}
      {message && !errorMessage ? <div className="notice">{message}</div> : null}

      <div className="landing-grid">
        <section className="card">
          <h2>Compare files</h2>
          <p className="hint">Choose a left and right spreadsheet, then select a mode.</p>
          <div className="drop-grid">
            <DropZone title="Left file" file={leftFile} onFile={setLeftFile}
              accept=".xlsx,.xlsm,.csv,.txt,.log,.json" />
            <DropZone title="Right file" file={rightFile} onFile={setRightFile}
              accept=".xlsx,.xlsm,.csv,.txt,.log,.json" />
          </div>
          <div className="actions">
            <button className="btn-primary" onClick={runBasic} disabled={!!busyAction}>
              <Busy label="Basic Compare" busy={busyAction === "basic"} />
            </button>
            <button className="btn-ghost" onClick={runAdvancedUpload} disabled={!!busyAction}>
              <Busy label="Advanced Compare" busy={busyAction === "advanced"} />
            </button>
          </div>
          {busyAction === "basic" || busyAction === "advanced" ? (
            <Progress progress={progress} />
          ) : null}
        </section>

        <section className="card">
          <h2>Comparison history</h2>
          <p className="hint">Resume or delete a previous execution.</p>
          <div className="history-list">
            {executions.map((execution) => (
              <div className="history-row" key={execution.execution_id}>
                <div className="meta resume" onClick={() => resume(execution.execution_id)}>
                  <div className="id">{execution.execution_id}</div>
                  <div className="files">
                    {execution.left_file_name} vs {execution.right_file_name}
                  </div>
                </div>
                <span className={"pill " + execution.status}>{execution.status}</span>
                <button className="icon-btn" title="Delete"
                  onClick={() => remove(execution.execution_id)}>&#128465;</button>
              </div>
            ))}
            {executions.length === 0 ? (
              <div className="count">No comparisons yet.</div>
            ) : null}
          </div>
        </section>
      </div>

      {completed ? (
        <button className={"settings-ribbon" + (settingsOpen ? " open" : "")}
          onClick={() => setSettingsOpen(!settingsOpen)}>
          <span className="chev" aria-hidden="true">&#9654;</span>
          <span className="ribbon-text">
            <strong>Adjust the comparison settings</strong>
            <span>Change the sheets, column mapping, keys or rules, then run it again.</span>
          </span>
          <span className="ribbon-action">{settingsOpen ? "Hide settings" : "Show settings"}</span>
        </button>
      ) : null}

      {showAdvanced && step >= 3 ? (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Select sheets</h2>
          <p className="hint">Choose which sheets should be compared.</p>
          <div className="field-grid">
            <label className="field">
              Left sheet
              <select value={leftSheet} onChange={(event) => setLeftSheet(event.target.value)}>
                {leftSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
              </select>
            </label>
            <label className="field">
              Right sheet
              <select value={rightSheet} onChange={(event) => setRightSheet(event.target.value)}>
                {rightSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
              </select>
            </label>
          </div>
          <div className="actions">
            <button className="btn-primary" onClick={saveSheets} disabled={!!busyAction}>
              <Busy label="Save and continue" busy={busyAction === "sheets"} />
            </button>
          </div>
        </section>
      ) : null}

      {showAdvanced && step >= 4 && pairs.length ? (
        <MapColumns pairs={pairs} setPairs={setPairs}
          primaryKeys={primaryKeys} setPrimaryKeys={setPrimaryKeys}
          busy={busyAction === "mapping"} onSave={() => saveMapping(5)} />
      ) : null}

      {showAdvanced && step >= 5 && rules ? (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Rules</h2>
          <p className="hint">Normalization rules applied before values are compared.</p>
          <div className="checks">
            {Object.keys(RULE_LABELS).map((key) => (
              <label key={key}>
                <input type="checkbox" checked={!!rules[key]}
                  onChange={(event) => setRules({ ...rules, [key]: event.target.checked })} />
                {RULE_LABELS[key]}
              </label>
            ))}
            <label>
              Fuzzy threshold
              <input type="number" step="0.05" min="0" max="1" style={{ width: 90 }}
                value={rules.fuzzy_threshold}
                onChange={(event) =>
                  setRules({ ...rules, fuzzy_threshold: Number(event.target.value) })} />
            </label>
          </div>
          <div className="actions">
            <button className="btn-primary" onClick={() => saveMapping(6)} disabled={!!busyAction}>
              <Busy label="Save rules" busy={busyAction === "mapping"} />
            </button>
            <button className="btn-ghost" onClick={refreshValidation} disabled={!!busyAction}>
              <Busy label="Validate" busy={busyAction === "validation"} />
            </button>
          </div>
        </section>
      ) : null}

      {showAdvanced && step >= 6 ? (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="toolbar">
            <h2 className="grow" style={{ margin: 0 }}>Validation</h2>
            <button className="btn-ghost btn-small"
              onClick={() => setValidationOpen(!validationOpen)}>
              {validationOpen ? "Hide details" : "Show details"}
            </button>
          </div>
          <p className="hint">
            {validation
              ? validation.ok
                ? "Validation passed. You can run the comparison."
                : "Validation found blocking issues."
              : "Run validation to check the mapping."}
          </p>
          {validationOpen && validation ? (
            <ul>
              {(validation.issues || []).map((issue, index) => (
                <li key={index}>[{issue.level}] {issue.message}</li>
              ))}
              {(validation.issues || []).length === 0 ? <li>No issues found.</li> : null}
            </ul>
          ) : null}
          <div className="actions">
            <button className="btn-primary" onClick={runCompare}
              disabled={!!busyAction || (validation && !validation.ok)}>
              <Busy label="Run compare" busy={busyAction === "compare"} />
            </button>
          </div>
          {busyAction === "compare" ? <Progress progress={progress} /> : null}
        </section>
      ) : null}

      {completed ? (
        <Results results={results} summary={summary} executionId={executionId}
          activeTab={activeTab} setActiveTab={setActiveTab}
          tabState={tabState} setTabState={setTabState} onError={setErrorMessage} />
      ) : null}

      <FeedbackBar counts={counts} onOpen={() => setFeedbackOpen(true)}
        onExport={() => setExportOpen(true)} />
      {feedbackOpen ? <FeedbackDialog onClose={() => setFeedbackOpen(false)} /> : null}
      {exportOpen ? <ExportFeedbackDialog onClose={() => setExportOpen(false)} /> : null}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
