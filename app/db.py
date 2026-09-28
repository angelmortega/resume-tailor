import json
import sqlite3
from datetime import datetime

from .config import DB_PATH

STATUSES = ["draft", "applied", "interview", "offer", "rejected"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL,
    applied_at      TEXT,
    company         TEXT DEFAULT '',
    role            TEXT DEFAULT '',
    location        TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'draft',
    job_description TEXT NOT NULL,
    notes           TEXT DEFAULT '',
    changes         TEXT DEFAULT '',
    ats             TEXT DEFAULT '{}',
    job_state       TEXT DEFAULT 'idle',   -- idle | running | error
    job_message     TEXT DEFAULT ''
);
"""


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with connect() as c:
        c.executescript(SCHEMA)
        # A server restart kills any in-flight job; don't leave it spinning forever.
        c.execute(
            "UPDATE applications SET job_state='error', job_message='Interrupted (server restarted). Try again.' "
            "WHERE job_state='running'"
        )


def _row(r):
    if r is None:
        return None
    d = dict(r)
    d["ats"] = json.loads(d["ats"] or "{}")
    return d


def create(job_description: str) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO applications (created_at, job_description, job_state, job_message) VALUES (?, ?, 'running', 'Starting…')",
            (datetime.now().isoformat(timespec="seconds"), job_description),
        )
        return cur.lastrowid


def get(app_id: int):
    with connect() as c:
        return _row(c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone())


def list_all():
    with connect() as c:
        rows = c.execute(
            "SELECT id, created_at, applied_at, company, role, location, status, job_state, ats "
            "FROM applications ORDER BY COALESCE(applied_at, created_at) DESC"
        ).fetchall()
        return [_row(r) for r in rows]


def update(app_id: int, **fields):
    if "ats" in fields and not isinstance(fields["ats"], str):
        fields["ats"] = json.dumps(fields["ats"])
    cols = ", ".join(f"{k}=?" for k in fields)
    with connect() as c:
        c.execute(f"UPDATE applications SET {cols} WHERE id=?", (*fields.values(), app_id))


def delete(app_id: int):
    with connect() as c:
        c.execute("DELETE FROM applications WHERE id=?", (app_id,))
