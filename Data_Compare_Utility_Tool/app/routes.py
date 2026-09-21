"""HTTP API for the Data Compare Utility."""

import json
import os
import shutil
import threading
from datetime import datetime

from flask import Blueprint, Response, current_app, jsonify, request, send_file

from . import compare as engine
from .db import get_conn

api = Blueprint("api", __name__)

# ---------------------------------------------------------------------------
# Transient progress reporting
# ---------------------------------------------------------------------------

PROGRESS = {}
PROGRESS_LOCK = threading.Lock()
PROGRESS_LIMIT = 100


def _set_progress(operation_id, percent, status):
    if not operation_id:
        return
    with PROGRESS_LOCK:
        PROGRESS[operation_id] = {
            "percent": max(0, min(100, int(percent))),
            "status": status,
            "updated_at": datetime.now().isoformat(),
        }
        if len(PROGRESS) > PROGRESS_LIMIT:
            for stale in sorted(PROGRESS, key=lambda key: PROGRESS[key]["updated_at"])[:-PROGRESS_LIMIT]:
                PROGRESS.pop(stale, None)


@api.get("/progress/<operation_id>")
def get_progress(operation_id):
    with PROGRESS_LOCK:
        state = PROGRESS.get(operation_id)
    if not state:
        return jsonify({"percent": 0, "status": "Waiting to start"})
    return jsonify({"percent": state["percent"], "status": state["status"]})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _db_path():
    return current_app.config["DB_PATH"]


def _output_dir():
    return current_app.config["OUTPUT_DIR"]


def _execution_dir(execution_id):
    return os.path.join(_output_dir(), execution_id)


def _new_execution_id():
    # Microsecond precision keeps rapid uploads from colliding.
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _loads(value, fallback):
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def _execution_row(conn, execution_id):
    return conn.execute(
        "SELECT * FROM executions WHERE execution_id = ?", (execution_id,)
    ).fetchone()


def _execution_dict(row):
    return {
        "execution_id": row["execution_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "status": row["status"],
        "current_step": row["current_step"],
        "left_file_name": row["left_file_name"],
        "right_file_name": row["right_file_name"],
        "left_sheet": row["left_sheet"],
        "right_sheet": row["right_sheet"],
        "left_order": _loads(row["left_order_json"], []),
        "right_order": _loads(row["right_order_json"], []),
        "column_pairs": _loads(row["pairs_json"], None),
        "primary_keys": _loads(row["primary_keys_json"], []),
        "rules": _loads(row["rules_json"], engine.default_rules()),
        "summary": _loads(row["summary_json"], None),
    }


def _touch(conn, execution_id, **fields):
    fields["updated_at"] = _now()
    assignments = ", ".join("%s = ?" % name for name in fields)
    conn.execute(
        "UPDATE executions SET %s WHERE execution_id = ?" % assignments,
        list(fields.values()) + [execution_id],
    )


def _save_uploads(execution_id, left_file, right_file):
    folder = _execution_dir(execution_id)
    os.makedirs(folder, exist_ok=True)
    left_path = os.path.join(folder, "left_%s" % os.path.basename(left_file.filename))
    right_path = os.path.join(folder, "right_%s" % os.path.basename(right_file.filename))
    left_file.save(left_path)
    right_file.save(right_path)
    return left_path, right_path


def _stored_matches(row, left_columns, right_columns, rules):
    """Honour the arrangement saved from the mapping screen, else auto-match by name."""
    pairs = _loads(row["pairs_json"], None) if "pairs_json" in row.keys() else None
    if pairs:
        return engine.matches_from_pairs(pairs)
    return engine.auto_match_columns(left_columns, right_columns, rules)


def _matches_for(row):
    left_columns = _loads(row["left_order_json"], [])
    right_columns = _loads(row["right_order_json"], [])
    rules = _loads(row["rules_json"], engine.default_rules())
    return _stored_matches(row, left_columns, right_columns, rules), left_columns, rules


def _validate(left_columns, right_columns, matches, primary_keys):
    resolved = engine.resolve_column_matches(matches)
    missing_keys = [key for key in primary_keys if key not in resolved["right_name_by_left"]]
    unmapped = [m["left_name"] for m in matches if m["status"] == "missing"]
    issues = []
    if not primary_keys:
        issues.append({"level": "error", "message": "Select at least one primary key column."})
    for key in missing_keys:
        issues.append({
            "level": "error",
            "message": "Primary key '%s' has no matching column in the right file." % key,
        })
    for name in unmapped:
        issues.append({
            "level": "warning",
            "message": "Column '%s' has no counterpart in the right file and is ignored." % name,
        })
    return {
        "ok": not missing_keys and bool(primary_keys),
        "issues": issues,
        "missing_keys": missing_keys,
        "unmapped_columns": unmapped,
        "comparable_columns": resolved["comparable_left_columns"],
        "left_column_count": len(left_columns),
        "right_column_count": len(right_columns),
    }


# ---------------------------------------------------------------------------
# Executions
# ---------------------------------------------------------------------------

@api.get("/executions")
def list_executions():
    with get_conn(_db_path()) as conn:
        rows = conn.execute(
            "SELECT * FROM executions ORDER BY created_at DESC, execution_id DESC"
        ).fetchall()
        return jsonify({"executions": [_execution_dict(row) for row in rows]})


def _create_execution(conn, execution_id, left_file, right_file, status, step):
    left_path, right_path = _save_uploads(execution_id, left_file, right_file)
    engine.detect_file_type(left_file.filename)
    engine.detect_file_type(right_file.filename)
    stamp = _now()
    conn.execute(
        "INSERT INTO executions (execution_id, created_at, updated_at, status, current_step,"
        " left_file_name, right_file_name, left_file_path, right_file_path, rules_json)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (execution_id, stamp, stamp, status, step, left_file.filename, right_file.filename,
         left_path, right_path, json.dumps(engine.default_rules())),
    )
    return left_path, right_path


@api.post("/executions")
def create_execution():
    """Advanced Compare upload: stage files and read their sheet names."""
    operation_id = request.form.get("operation_id")
    left_file = request.files.get("left_file")
    right_file = request.files.get("right_file")
    if not left_file or not right_file:
        return jsonify({"error": "Both a left file and a right file are required."}), 400

    _set_progress(operation_id, 10, "Receiving uploaded files")
    execution_id = _new_execution_id()
    with get_conn(_db_path()) as conn:
        left_path, right_path = _create_execution(
            conn, execution_id, left_file, right_file, "uploaded", 2
        )
        _set_progress(operation_id, 45, "Reading workbook sheets")
        left_sheets = engine.list_sheets(left_path, engine.detect_file_type(left_file.filename))
        right_sheets = engine.list_sheets(right_path, engine.detect_file_type(right_file.filename))
        _set_progress(operation_id, 80, "Saving the Advanced Compare session")
        _touch(conn, execution_id, current_step=3)
        row = _execution_row(conn, execution_id)
        payload = _execution_dict(row)

    _set_progress(operation_id, 100, "Files are ready for Advanced Compare")
    payload["current_step"] = 3
    return jsonify({
        "execution": payload,
        "execution_id": execution_id,
        "left_sheets": left_sheets,
        "right_sheets": right_sheets,
    })


@api.get("/executions/<execution_id>")
def get_execution(execution_id):
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        payload = _execution_dict(row)
        if row["left_file_path"] and os.path.exists(row["left_file_path"]):
            payload["left_sheets"] = engine.list_sheets(
                row["left_file_path"], engine.detect_file_type(row["left_file_name"]))
            payload["right_sheets"] = engine.list_sheets(
                row["right_file_path"], engine.detect_file_type(row["right_file_name"]))
        matches, left_columns, _ = _matches_for(row)
        payload["matches"] = matches
        payload["left_columns"] = left_columns
        payload["right_columns"] = _loads(row["right_order_json"], [])
        return jsonify(payload)


@api.delete("/executions/<execution_id>")
def delete_execution(execution_id):
    with get_conn(_db_path()) as conn:
        conn.execute("DELETE FROM result_rows WHERE execution_id = ?", (execution_id,))
        conn.execute("DELETE FROM data_rows WHERE execution_id = ?", (execution_id,))
        conn.execute("DELETE FROM executions WHERE execution_id = ?", (execution_id,))
    shutil.rmtree(_execution_dir(execution_id), ignore_errors=True)
    workbook = os.path.join(_output_dir(), "comparison_%s.xlsx" % execution_id)
    if os.path.exists(workbook):
        os.remove(workbook)
    return jsonify({"deleted": execution_id})


# ---------------------------------------------------------------------------
# Advanced staged workflow
# ---------------------------------------------------------------------------

@api.get("/executions/<execution_id>/sheets")
def get_sheets(execution_id):
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        return jsonify({
            "left_sheets": engine.list_sheets(
                row["left_file_path"], engine.detect_file_type(row["left_file_name"])),
            "right_sheets": engine.list_sheets(
                row["right_file_path"], engine.detect_file_type(row["right_file_name"])),
            "left_sheet": row["left_sheet"],
            "right_sheet": row["right_sheet"],
        })


@api.post("/executions/<execution_id>/sheets")
def set_sheets(execution_id):
    body = request.get_json(silent=True) or {}
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        left_sheet = body.get("left_sheet")
        right_sheet = body.get("right_sheet")
        if not left_sheet or not right_sheet:
            return jsonify({"error": "Select a sheet on both sides."}), 400
        left_columns = engine.read_headers(
            row["left_file_path"], engine.detect_file_type(row["left_file_name"]), left_sheet)
        right_columns = engine.read_headers(
            row["right_file_path"], engine.detect_file_type(row["right_file_name"]), right_sheet)
        _touch(conn, execution_id, left_sheet=left_sheet, right_sheet=right_sheet,
               left_order_json=json.dumps(left_columns),
               right_order_json=json.dumps(right_columns),
               pairs_json=None,
               current_step=4, status="sheets_selected")
        rules = _loads(row["rules_json"], engine.default_rules())
        matches = engine.auto_match_columns(left_columns, right_columns, rules)
    return jsonify({
        "left_columns": left_columns,
        "right_columns": right_columns,
        "matches": matches,
        "current_step": 4,
    })


@api.get("/executions/<execution_id>/columns")
def get_columns(execution_id):
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        matches, left_columns, _ = _matches_for(row)
        return jsonify({
            "left_columns": left_columns,
            "right_columns": _loads(row["right_order_json"], []),
            "matches": matches,
            "primary_keys": _loads(row["primary_keys_json"], []),
            "rules": _loads(row["rules_json"], engine.default_rules()),
        })


@api.post("/executions/<execution_id>/mapping")
def set_mapping(execution_id):
    body = request.get_json(silent=True) or {}
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        pairs = body.get("column_pairs")
        if pairs:
            # Row position is the mapping; blanks mean "no counterpart on that side".
            left_columns = [p[0] for p in pairs if p and p[0]]
            right_columns = [p[1] for p in pairs if p and len(p) > 1 and p[1]]
        else:
            left_columns = body.get("left_order") or _loads(row["left_order_json"], [])
            right_columns = body.get("right_order") or _loads(row["right_order_json"], [])
        primary_keys = body.get("primary_keys") or []
        rules = dict(engine.default_rules())
        rules.update(_loads(row["rules_json"], {}) or {})
        rules.update(body.get("rules") or {})
        _touch(conn, execution_id,
               left_order_json=json.dumps(left_columns),
               right_order_json=json.dumps(right_columns),
               pairs_json=json.dumps(pairs) if pairs else row["pairs_json"],
               primary_keys_json=json.dumps(primary_keys),
               rules_json=json.dumps(rules),
               current_step=max(5, row["current_step"]),
               status="mapped")
        matches = (engine.matches_from_pairs(pairs) if pairs
                   else engine.auto_match_columns(left_columns, right_columns, rules))
        validation = _validate(left_columns, right_columns, matches, primary_keys)
    return jsonify({"matches": matches, "rules": rules, "primary_keys": primary_keys,
                    "validation": validation, "current_step": 5})


@api.get("/executions/<execution_id>/validation")
def get_validation(execution_id):
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        matches, left_columns, _ = _matches_for(row)
        validation = _validate(left_columns, _loads(row["right_order_json"], []), matches,
                               _loads(row["primary_keys_json"], []))
        _touch(conn, execution_id, current_step=max(6, row["current_step"]))
    return jsonify(validation)


# ---------------------------------------------------------------------------
# Running a comparison
# ---------------------------------------------------------------------------

def _execute_comparison(conn, row, operation_id, base_percent=40):
    """Load both sides and compare them; shared by Basic and Advanced."""
    execution_id = row["execution_id"]
    left_columns = _loads(row["left_order_json"], [])
    right_columns = _loads(row["right_order_json"], [])
    primary_keys = _loads(row["primary_keys_json"], [])
    rules = _loads(row["rules_json"], engine.default_rules())
    matches = _stored_matches(row, left_columns, right_columns, rules)

    _set_progress(operation_id, base_percent, "Validating the column mapping")
    validation = _validate(left_columns, right_columns, matches, primary_keys)
    if not validation["ok"]:
        return None, validation, matches, rules

    _set_progress(operation_id, base_percent + 10, "Loading rows from the left file")
    engine.stream_to_sqlite(
        conn, execution_id, "left", row["left_file_path"],
        engine.detect_file_type(row["left_file_name"]), row["left_sheet"],
        left_columns, matches, primary_keys, rules)

    _set_progress(operation_id, base_percent + 25, "Loading rows from the right file")
    engine.stream_to_sqlite(
        conn, execution_id, "right", row["right_file_path"],
        engine.detect_file_type(row["right_file_name"]), row["right_sheet"],
        left_columns, matches, primary_keys, rules)

    _set_progress(operation_id, base_percent + 45,
                  "Comparing rows and creating the legacy Excel workbook")
    summary = engine.run_comparison(conn, execution_id, left_columns, matches, rules,
                                    _execution_dir(execution_id))
    summary["primary_keys"] = primary_keys
    summary["comparable_columns"] = validation["comparable_columns"]
    _touch(conn, execution_id, status="completed", current_step=7,
           summary_json=json.dumps(summary))
    return summary, validation, matches, rules


@api.post("/executions/<execution_id>/compare")
def run_compare(execution_id):
    body = request.get_json(silent=True) or {}
    operation_id = body.get("operation_id")
    _set_progress(operation_id, 5, "Preparing/receiving files")
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        _set_progress(operation_id, 20, "Reading workbook sheets")
        _set_progress(operation_id, 30, "Reading and matching columns")
        summary, validation, _, _ = _execute_comparison(conn, row, operation_id)
        if summary is None:
            _set_progress(operation_id, 100, "Validation blocked the comparison")
            return jsonify({"error": "Validation failed.", "validation": validation}), 400
    _set_progress(operation_id, 100, "Comparison completed")
    return jsonify({"summary": summary, "validation": validation, "current_step": 7})


@api.post("/executions/basic")
def create_basic_execution():
    """One-click compare: first sheets, all matched columns as the composite key."""
    operation_id = request.form.get("operation_id")
    left_file = request.files.get("left_file")
    right_file = request.files.get("right_file")
    if not left_file or not right_file:
        return jsonify({"error": "Both a left file and a right file are required."}), 400

    _set_progress(operation_id, 5, "Preparing/receiving files")
    execution_id = _new_execution_id()
    with get_conn(_db_path()) as conn:
        left_path, right_path = _create_execution(
            conn, execution_id, left_file, right_file, "uploaded", 2)

        _set_progress(operation_id, 20, "Reading workbook sheets")
        left_type = engine.detect_file_type(left_file.filename)
        right_type = engine.detect_file_type(right_file.filename)
        left_sheets = engine.list_sheets(left_path, left_type)
        right_sheets = engine.list_sheets(right_path, right_type)
        left_sheet = left_sheets[0]
        right_sheet = right_sheets[0]

        _set_progress(operation_id, 30, "Reading and matching columns")
        left_columns = engine.read_headers(left_path, left_type, left_sheet)
        right_columns = engine.read_headers(right_path, right_type, right_sheet)
        rules = engine.default_rules()
        matches = engine.auto_match_columns(left_columns, right_columns, rules)
        resolved = engine.resolve_column_matches(matches)
        if (left_type in engine.LINE_BASED_TYPES
                and right_type in engine.LINE_BASED_TYPES):
            # Line by line: the line number is the key, the line content is compared.
            primary_keys = [engine.TEXT_LINE_COLUMN]
        else:
            # Basic mode uses every retained column as the complete composite key.
            primary_keys = list(resolved["comparable_left_columns"])

        _touch(conn, execution_id, left_sheet=left_sheet, right_sheet=right_sheet,
               left_order_json=json.dumps(left_columns),
               right_order_json=json.dumps(right_columns),
               primary_keys_json=json.dumps(primary_keys),
               rules_json=json.dumps(rules),
               current_step=6, status="mapped")

        row = _execution_row(conn, execution_id)
        summary, validation, matches, rules = _execute_comparison(conn, row, operation_id)
        if summary is None:
            _set_progress(operation_id, 100, "Validation blocked the comparison")
            return jsonify({"error": "Validation failed.", "validation": validation,
                            "execution_id": execution_id}), 400
        payload = _execution_dict(_execution_row(conn, execution_id))

    _set_progress(operation_id, 100, "Comparison completed")
    return jsonify({
        "execution": payload,
        "execution_id": execution_id,
        "left_sheet": left_sheet,
        "right_sheet": right_sheet,
        "left_sheets": left_sheets,
        "right_sheets": right_sheets,
        "left_columns": left_columns,
        "right_columns": right_columns,
        "matches": matches,
        "primary_keys": primary_keys,
        "rules": rules,
        "validation": validation,
        "summary": summary,
        "current_step": 7,
    })


# ---------------------------------------------------------------------------
# Results and exports
# ---------------------------------------------------------------------------

def _results_payload(conn, row):
    execution_id = row["execution_id"]
    left_columns = _loads(row["left_order_json"], [])
    rules = _loads(row["rules_json"], engine.default_rules())
    matches = _stored_matches(row, left_columns, _loads(row["right_order_json"], []), rules)
    resolved = engine.resolve_column_matches(matches)
    comparable = resolved["comparable_left_columns"]

    payload = {"common": [], "mismatch_first": [], "mismatch_second": [], "duplicate": [],
               "compare": []}
    for result_type, _ in engine.LEGACY_SHEETS:
        payload[result_type] = engine._fetch_results(conn, execution_id, result_type)
    payload["compare"] = engine.build_aligned_rows(conn, execution_id, comparable, rules)
    payload["columns"] = left_columns
    payload["comparable_columns"] = comparable
    payload["right_labels"] = {c: resolved["right_name_by_left"].get(c, c) for c in comparable}
    payload["matches"] = matches
    payload["summary"] = _loads(row["summary_json"], None)
    payload["primary_keys"] = _loads(row["primary_keys_json"], [])
    return payload


@api.get("/executions/<execution_id>/results")
def get_results(execution_id):
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        return jsonify(_results_payload(conn, row))


def _workbook_response(execution_id, data):
    import io as _io
    return send_file(
        _io.BytesIO(data),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="comparison_%s.xlsx" % execution_id,
    )


@api.get("/executions/<execution_id>/download/excel")
def download_excel(execution_id):
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        left_columns = _loads(row["left_order_json"], [])
        rules = _loads(row["rules_json"], engine.default_rules())
        matches = _stored_matches(row, left_columns, _loads(row["right_order_json"], []), rules)
        data = engine.export_workbook(conn, execution_id, left_columns, matches, rules,
                                      include_compare=True)
    return _workbook_response(execution_id, data)


@api.post("/executions/<execution_id>/download/excel/compare")
def download_excel_compare(execution_id):
    body = request.get_json(silent=True) or {}
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        left_columns = _loads(row["left_order_json"], [])
        rules = _loads(row["rules_json"], engine.default_rules())
        matches = _stored_matches(row, left_columns, _loads(row["right_order_json"], []), rules)
        comparable = engine.resolve_column_matches(matches)["comparable_left_columns"]
        selected = [c for c in (body.get("selected_columns") or comparable) if c in comparable]
        # Row payloads are always rehydrated from SQLite; only the order is trusted.
        data = engine.export_workbook(conn, execution_id, left_columns, matches, rules,
                                      include_compare=True,
                                      selected_columns=selected or comparable,
                                      row_order=body.get("row_order"))
    return _workbook_response(execution_id, data)


@api.get("/executions/<execution_id>/download/csv/<result_type>")
def download_csv(execution_id, result_type):
    valid = {name for name, _ in engine.LEGACY_SHEETS}
    if result_type not in valid:
        return jsonify({"error": "Unknown result type '%s'." % result_type}), 400
    with get_conn(_db_path()) as conn:
        row = _execution_row(conn, execution_id)
        if not row:
            return jsonify({"error": "Execution not found."}), 404
        columns = _loads(row["left_order_json"], [])
        records = engine._fetch_results(conn, execution_id, result_type)
    body = engine.results_to_csv(records, columns)
    return Response(
        body,
        mimetype="text/csv",
        headers={"Content-Disposition":
                 "attachment; filename=%s_%s.csv" % (result_type, execution_id)},
    )


@api.post("/clear-db")
def clear_db():
    with get_conn(_db_path()) as conn:
        conn.execute("DELETE FROM result_rows")
        conn.execute("DELETE FROM data_rows")
        conn.execute("DELETE FROM executions")
    output = _output_dir()
    for entry in os.listdir(output):
        path = os.path.join(output, entry)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif entry.endswith(".xlsx"):
            os.remove(path)
    return jsonify({"cleared": True})


@api.errorhandler(ValueError)
def handle_value_error(error):
    return jsonify({"error": str(error)}), 400
