# Data Compare Utility — starter guide

A local Flask + SQLite application that compares two files (`.xlsx`, `.xlsm`, `.csv`, `.txt`,
`.json`)
and shows the differences in a React review UI. No Node build step is required: React and
Babel are served from `static/vendor/`.

## Requirements

- Python 3.10 or newer
- Flask 3+, openpyxl 3.1+ (`requirements.txt`)

## Run it

Windows:

```
start_excel_compare.bat
```

macOS / Linux:

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

Then open <http://127.0.0.1:8000>.

The debug reloader is deliberately disabled in `main.py` so two Flask processes never
contend for the same SQLite database.

## Two ways to compare

**Basic Compare** — pick both files and click once. It selects the first sheet on each side,
auto-matches columns, and uses *every* matched column as the composite key with the default
rules. Because the key is the whole row, a changed row shows up as a left-only row plus a
right-only row.

**Advanced Compare** — the staged workflow: Upload → Select sheets → Map columns → Rules →
Validation → Run compare. You pick one or more primary keys, edit the normalization rules,
and arrange the column pairing by hand. Validation blocks the run if a chosen key has no
counterpart on the right.

On **Map columns** each row pairs one left column with one right column, separated by a
vertical rule. Names are seeded from the automatic match, then dragged up or down their own
side to realign them; a blank slot opposite a name means that column has no counterpart, and
`Add blank row` creates a gap to drag into. The leftmost checkboxes (with a select-all in the
header) choose the primary keys — ticking every one is the same whole-row check that Basic
Compare performs.

**Row position is the mapping.** Once a mapping is saved the arrangement is stored in
`executions.pairs_json` and used verbatim everywhere downstream, so two columns whose names
look nothing alike are compared as a pair because you put them on the same row. Automatic
name matching only supplies the starting arrangement and remains the fallback for Basic
Compare and for executions saved before a mapping exists. Choosing sheets again clears the
saved arrangement, because the headers it referred to may no longer exist.

## Adjusting a finished run

Once results are on screen, both modes show an **Adjust the comparison settings** ribbon just
above them. Expanding it reveals the Advanced screens — Select sheets, Map columns, Rules and
Validation — already filled in from the run that just finished, so a Basic Compare can be
reopened and refined without starting over. The panel stays open across saves and re-runs, and
closes only on **Hide settings**; the results from the last completed run stay on screen the
whole time.

## Line-based files: text and JSON

`.txt`, `.log` and `.json` have no columns of their own, so they are read as two synthesised
columns: `Line`, the 1-based line number, and `Text`, the line itself. Basic Compare on two
such files keys on `Line`, which is what makes the comparison run line by line — line 5 is
compared against line 5, an edited line shows as a change rather than as a deletion plus an
insertion, and a line present in only one file is reported as missing. Everything else — the
tabs, the side-by-side Compare view, the exports — behaves exactly as it does for
spreadsheets.

A `.json` file is re-serialised before it is split into lines, with `sort_keys=True` and a
two-space indent. Two files holding the same data therefore compare as identical even when
one is minified, indented differently, or lists its object keys in another order. A file that
does not parse as JSON is compared as plain text instead, so a malformed file still produces
a useful result rather than an error.

Because the comparison is positional, inserting a line shifts every line after it and those
shifted lines are all reported as differences. That is inherent to comparing line by line
rather than a fault — for a structural view of a spreadsheet, use a key column instead.

## Results

Six tabs, opening on the first: Differences side by side, Matching rows, First file
mismatches, Second file mismatches, Duplicates, and Summary. A line under the Results heading states the key the rows were matched on (or says
the check was row by row), and each tab opens with a sentence describing what it holds.
Every tab filters, sorts, paginates and picks columns in the browser — none of it re-runs
the comparison. Columns are chosen from a searchable checkbox dropdown so wide files stay
manageable, and the two mismatch tabs put a per-row `»` button in the first column that
jumps to that row's first differing cell, revealing the column if it was hidden.

The **Differences side by side** tab shows two synchronized tables (Left file and Right
file) built from the same aligned rows, so matching records stay level. Both tables use a
fixed column width and therefore have identical geometry, and scrolling either one — across
or down — moves the other to the same position, so the same column and the same row are
always on screen in both. Wide files get a real horizontal scrollbar rather than having every
column squeezed to fit.

Each row carries a `»` button in both panes that scrolls straight to the row's first
differing cell and flashes it on both sides, revealing the column first if it had been
unticked. The jump sets each pane's scroll position directly rather than using
`scrollIntoView`: a smooth animation cannot survive here, because the panes mirror one
another and the mirrored write interrupts the animation part way. It lists only rows that differ or are
missing on one side — fully matching rows live in the Common tab. Differences are yellow,
cells missing on one side are red, blank keys sort last, and each side has its own search box
in its header. The Compare sheet in the exported workbook still contains every aligned row.

The **Duplicates** tab carries an extra **Found in** column saying whether the repeated key
was found in the left file or the right one, since a duplicate belongs to one side only.

Every flagged row carries a plain sentence saying why, generated by `describe_record` in
`app/compare.py` and mirrored by `describeRecord` in `static/app.js` so the screen, the CSV
and the workbook all word it the same way: *"This row is present in the left file but not in
the right file"*, *"Amount and Notes do not match the right file"*, *"This key appears 2 times
in the left file"*. The wording follows the side the row came from, so the two mismatch tabs
read from their own file's point of view.

## The Summary tab

With a real key column, changed rows pair up by key and the tab lists each one directly.

When the **whole row is the key** — Basic Compare, or every column ticked on the mapping
screen — an edited row cannot pair up with itself: it lands as one left-only record and one
right-only record with different keys. The tab therefore falls back to matching each leftover
row against its closest counterpart in the other file, scored on how many column values agree
and requiring at least half of them to match. Those rows are reported as changes under a note
saying the pairing was inferred, and anything still unmatched is listed under **Only in the
left file** / **Only in the right file**. Before this fallback existed the tab simply reported
"no paired differences" for every Basic Compare.

## Feedback and usage counters

A bar at the foot of the page shows two running totals on the left and carries **Export** and
**Feedback & suggest** on the right. It drops to the bottom of the window on a short page and
stays pinned there once the content is tall enough to scroll.

**Feedback & suggest** opens a dialog with a category (Suggestion / Bug or problem /
Question) and a free-text box. Pressing send does two things: the note is posted to
`/api/feedback` and written to the `feedback` table, and the browser is handed a `mailto:`
link addressed to whoever `FEEDBACK_EMAIL` names in `static/app.js`. Storing it first is the
point — a machine with no mail client registered for `mailto:` (common on Linux) silently
does nothing, and without the stored copy that feedback would simply be lost.

**Export** opens a date range, defaulting to today at both ends, and downloads everything
submitted in that window as a plain text file that can be attached to an email by hand. A
range with nothing in it reports that rather than downloading an empty file.

The counters live in the `analytics` table, one row per counter:

- `opens` — incremented by `POST /api/analytics/open`, which the page calls once per load
- `comparisons` — incremented inside `_execute_comparison`, so both Basic and Advanced count

Both are read back through `GET /api/analytics`, and the footer refreshes after each run.

```
sqlite3 output/compare.db "SELECT * FROM analytics;"
sqlite3 output/compare.db "SELECT created_at, category, message FROM feedback;"
```

## Exports

- **Download Excel workbook** — the four legacy sheets (Common data, Data mismatch in First
  file, Data mismatch in Second file, Duplicate entries) plus a `Compare` sheet laid out as
  left columns, one empty separator column, right columns.
- **Compare tab → Download Excel** — the same workbook, but limited to the columns you
  selected and ordered to match what you are looking at. Row values are always rehydrated
  from SQLite; only the ordering comes from the browser.
- **Download CSV** — exports the active tab after filtering and sorting. Raw per-category CSV
  endpoints remain available at `/api/executions/<id>/download/csv/<result_type>`.

The heavy Compare sheet is *not* built during a comparison — only on download. That keeps
the Results screen fast on wide or large files.

## Sample data

`sample/left_notes.txt` and `sample/right_notes.txt` are a six-line pair covering an edited
line, a replaced line and a line added only on the right — run them through Basic Compare to
see the line-by-line behaviour.

`sample/left_config.json` and `sample/right_config.json` hold the same kind of pair for JSON:
the right file is minified with its keys in a different order, so the nine lines that really
do agree still line up once both sides are normalised.

`sample/left_trades.csv` and `sample/right_trades.csv` hold ten records each, covering
padded whitespace, case differences, comma-separated and trailing-zero numbers, several date
formats, blank vs `NULL`, quoted commas, a duplicate key, rows unique to each side, blank
primary keys with an uneven number of occurrences, a fuzzy column name (`Notes` / `Note_s`)
and an unmapped column on each side (`Region` / `Branch`).

Run them through **Advanced Compare** with `Account ID` as the primary key to see every
category at once.

## Layout

```
main.py                  Flask entry point (port 8000)
app/__init__.py          app factory, paths, blueprint registration
app/db.py                schema, additive migrations, connection tuning (WAL, busy_timeout)
app/compare.py           reading, normalization, matching, comparison, exports
app/routes.py            REST API and in-memory progress reporting
static/                  index.html, app.js (React + Babel), styles.css, vendor/
output/                  uploads, compare.db, generated workbooks
sample/                  sample CSV pair
tests/                   unittest suite
```

## Tests

```
.venv/bin/python -m compileall main.py app tests
.venv/bin/python -W error::ResourceWarning -m unittest discover -s tests -v
```
