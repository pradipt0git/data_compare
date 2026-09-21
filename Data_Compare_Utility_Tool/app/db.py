"""SQLite access layer for the Data Compare Utility."""

import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS executions (
    execution_id      TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    status            TEXT NOT NULL,
    current_step      INTEGER NOT NULL DEFAULT 1,
    left_file_name    TEXT,
    right_file_name   TEXT,
    left_file_path    TEXT,
    right_file_path   TEXT,
    left_sheet        TEXT,
    right_sheet       TEXT,
    left_order_json   TEXT,
    right_order_json  TEXT,
    pairs_json        TEXT,
    primary_keys_json TEXT,
    rules_json        TEXT,
    summary_json      TEXT
);

CREATE TABLE IF NOT EXISTS data_rows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    side         TEXT NOT NULL,
    row_index    INTEGER NOT NULL,
    key_norm     TEXT NOT NULL,
    row_json     TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES executions (execution_id)
);

CREATE INDEX IF NOT EXISTS idx_data_rows_exec_side_key
    ON data_rows (execution_id, side, key_norm);

CREATE TABLE IF NOT EXISTS result_rows (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id       TEXT NOT NULL,
    result_type        TEXT NOT NULL,
    side               TEXT,
    key_norm           TEXT,
    row_json           TEXT NOT NULL,
    mismatch_cols_json TEXT,
    duplicate_count    INTEGER,
    is_missing         INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (execution_id) REFERENCES executions (execution_id)
);

CREATE INDEX IF NOT EXISTS idx_result_rows_exec_type
    ON result_rows (execution_id, result_type);
"""


def _connect(db_path):
    """Single place where SQLite connections are created and tuned."""
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


# Columns added after the first release; databases created earlier lack them.
ADDED_COLUMNS = (("executions", "pairs_json", "TEXT"),)


def _apply_migrations(conn):
    for table, column, column_type in ADDED_COLUMNS:
        existing = {r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)}
        if column not in existing:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, column_type))


def init_db(db_path):
    conn = _connect(db_path)
    try:
        conn.executescript(SCHEMA)
        _apply_migrations(conn)
        conn.commit()
    finally:
        conn.close()


@contextmanager
def get_conn(db_path):
    conn = _connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
