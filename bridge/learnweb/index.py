"""Volltextindex (SQLite FTS5) über Kurs-, Abschnitts- und Aktivitätsnamen und die Texte der Kursdateien.

    uv run python -m learnweb.cli index [--rebuild]

Gespeist aus data/sync_state.json und den gespiegelten Dateien (PDF seitenweise, PPTX folienweise, DOCX in Abschnitten).
Inkrementell über Pfad + Änderungszeit + Größe; was nicht mehr im State steht oder auf der Platte fehlt, fliegt raus.
Kaputte oder verschlüsselte Dateien werden übersprungen und in `files` vermerkt, nie abgebrochen.
Lizenz-Leitplanke: kein PyMuPDF/MuPDF (AGPL).

Schema (Rust liest es nur):
    entries(id, course_id, cmid, path, kind, title, page)
        kind: course | section | activity | news (Ankuendigung) | assignment (Aufgabe) | pdf | docx | pptx
        path: relativ zu `ziel` (Datei bzw. erste Datei der Aktivität, bei course die Kursnotiz), sonst ''
        page: Seite (PDF) bzw. Folie (PPTX), sonst NULL
    fts(title, body)  -- FTS5, rowid = entries.id, tokenize 'unicode61 remove_diacritics 2'
    files(path, mtime, size, status, note, course_id, cmid)  -- status: ok | empty | error
    meta(key, value)  -- schema_version, built_at
Suchtext ist mit norm() vorbereitet: Umlaute zusammengesetzt (NFC), ß wird zu ss (der Tokenizer faltet ß nicht).
Anfragen müssen ß ebenso ersetzen (fts_query); Ausschnitte zeigen deshalb „ss“ statt „ß“.
Aus dem Text fliegen Steuerzeichen und Aufzählungszeichen aus Symbolschriften (private Unicode-Zeichen), clean().
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import time
import unicodedata
from collections import Counter
from pathlib import Path

SCHEMA_VERSION = 1
MARK_OPEN, MARK_CLOSE = "\x01", "\x02"  # um Treffer im Ausschnitt; kein HTML, die Oberfläche maskiert selbst
EXTENSIONS = {".pdf": "pdf", ".docx": "docx", ".pptx": "pptx"}
CHUNK = 1500  # Zeichen je DOCX-Abschnitt

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, mtime REAL, size INTEGER, status TEXT, note TEXT, course_id INTEGER, cmid INTEGER);
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY, course_id INTEGER, cmid INTEGER, path TEXT, kind TEXT, title TEXT, page INTEGER);
CREATE INDEX IF NOT EXISTS entries_path ON entries(path);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
"""


_JUNK = re.compile(r"[\x00-\x08\x0b-\x1f-]")  # Steuerzeichen und Aufzählungszeichen aus Symbolschriften


def norm(s: str) -> str:
    """Für Index und Anfragen: zusammengesetzte Umlaute (PDFs liefern oft o + Trema), ß -> ss."""
    return unicodedata.normalize("NFC", s).replace("ß", "ss").replace("ẞ", "SS")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", _JUNK.sub(" ", text)).strip()


# --------------------------------------------------------------------------- Datenbank

def connect(db: Path, fresh: bool = False) -> sqlite3.Connection:
    db = Path(db)
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    version = None
    try:
        row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        version = int(row[0]) if row else None
    except sqlite3.OperationalError:
        pass
    if fresh or (version is not None and version != SCHEMA_VERSION):
        for t in ("fts", "entries", "files", "meta"):
            con.execute(f"DROP TABLE IF EXISTS {t}")
    con.executescript(_SCHEMA)
    con.execute("INSERT OR REPLACE INTO meta VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
    con.commit()
    return con


def _add(con, course_id, cmid, path, kind, title, page, body="") -> None:
    cur = con.execute("INSERT INTO entries(course_id, cmid, path, kind, title, page) VALUES (?,?,?,?,?,?)",
                      (course_id, cmid, path, kind, title, page))
    con.execute("INSERT INTO fts(rowid, title, body) VALUES (?,?,?)", (cur.lastrowid, norm(title), norm(body)))


def _drop_path(con, path: str) -> None:
    con.execute("DELETE FROM fts WHERE rowid IN (SELECT id FROM entries WHERE path=? AND kind IN ('pdf','docx','pptx'))", (path,))
    con.execute("DELETE FROM entries WHERE path=? AND kind IN ('pdf','docx','pptx')", (path,))


# --------------------------------------------------------------------------- Textauszug

def _pdf(path: Path):
    from pypdf import PdfReader
    r = PdfReader(str(path))
    if r.is_encrypted and not r.decrypt(""):
        raise ValueError("verschlüsselt")
    for i, p in enumerate(r.pages, 1):
        try:
            text = p.extract_text() or ""
        except Exception:  # eine kaputte Seite soll nicht die ganze Datei kosten
            text = ""
        yield i, text


def _chunks(parts: list[str]):
    buf = ""
    for p in parts:
        if buf and len(buf) + len(p) > CHUNK:
            yield None, buf
            buf = ""
        buf += (" " if buf else "") + p
    if buf:
        yield None, buf


def _docx(path: Path):
    from docx import Document
    d = Document(str(path))
    parts = [p.text.strip() for p in d.paragraphs if p.text.strip()]
    for t in d.tables:
        for row in t.rows:
            parts += [c.text.strip() for c in row.cells if c.text.strip()]
    yield from _chunks(parts)


def _shape_text(shape, out: list[str]) -> None:
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        out.append(shape.text_frame.text)
    if getattr(shape, "has_table", False) and shape.has_table:
        out += [c.text for row in shape.table.rows for c in row.cells]
    for sub in getattr(shape, "shapes", []):  # Gruppen enthalten weitere Formen
        _shape_text(sub, out)


def _pptx(path: Path):
    from pptx import Presentation
    for i, slide in enumerate(Presentation(str(path)).slides, 1):
        parts: list[str] = []
        for shape in slide.shapes:
            _shape_text(shape, parts)
        if slide.has_notes_slide:
            parts.append(slide.notes_slide.notes_text_frame.text)
        yield i, "\n".join(parts)


_EXTRACT = {"pdf": _pdf, "docx": _docx, "pptx": _pptx}


def extract(path: Path, kind: str) -> list[tuple[int | None, str]]:
    pages = ((page, clean(text)) for page, text in _EXTRACT[kind](path) if text)
    return [(page, text) for page, text in pages if text]


# --------------------------------------------------------------------------- Aktualisieren

def _wanted(state: dict) -> dict[str, tuple[int, int, str]]:
    """Dateien im State, die der Index liest: relativer Pfad -> (course_id, cmid, kind)."""
    out = {}
    for c in state.get("courses", {}).values():
        for cmid, cm in c.get("cms", {}).items():
            for f in cm.get("files", []):
                kind = EXTENSIONS.get(Path(f).suffix.lower())
                if kind and not Path(f).name.startswith("~$"):
                    out[f] = (c["id"], int(cmid), kind)
    return out


NAME_KINDS = "('course','section','activity','news','assignment')"


def _index_names(con, state: dict, content: dict | None = None) -> None:
    con.execute(f"DELETE FROM fts WHERE rowid IN (SELECT id FROM entries WHERE kind IN {NAME_KINDS})")
    con.execute(f"DELETE FROM entries WHERE kind IN {NAME_KINDS}")
    for c in state.get("courses", {}).values():
        _add(con, c["id"], None, f"{c['dir']}/{c['dir']}.md", "course", c["name"], None)
        seen = set()
        for title, _ in c.get("layout", []):
            if title and title not in seen:
                seen.add(title)
                _add(con, c["id"], None, "", "section", title, None)
        for cmid, cm in c.get("cms", {}).items():
            if cm.get("typ") == "label" or not cm.get("name"):
                continue  # Labels sind nur Überschriften/Text im Kurs
            files = cm.get("files") or [""]
            _add(con, c["id"], int(cmid), files[0], "activity", cm["name"], None)
        # Inhalte ohne Datei (content.py): Ankuendigungen und Aufgabenbeschreibungen, mit Text, damit die Suche sie findet
        extra = ((content or {}).get("courses") or {}).get(str(c["id"]), {})
        for n in extra.get("news", []):
            if n.get("title") or n.get("text"):
                _add(con, c["id"], n.get("forum"), "", "news", n.get("title") or "Ankündigung", None, n.get("text") or "")
        for a in extra.get("assignments", []):
            _add(con, c["id"], a.get("cmid"), "", "assignment", a.get("name") or "Aufgabe", None, a.get("intro") or "")


def update(state: dict, ziel: Path, db: Path, rebuild: bool = False, content: dict | None = None) -> dict:
    """Index auf den Stand von `state` bringen. Gibt Kennzahlen zurück (siehe Schlüssel unten)."""
    t0, ziel = time.time(), Path(ziel)
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    con = connect(db, fresh=rebuild)
    cnt: Counter = Counter()
    try:
        with con:
            _index_names(con, state, content)

        wanted = _wanted(state)
        known = {r[0]: r[1:] for r in con.execute("SELECT path, mtime, size, status, course_id, cmid FROM files")}
        for path in set(known) - set(wanted):
            with con:
                _drop_path(con, path)
                con.execute("DELETE FROM files WHERE path=?", (path,))
            cnt["removed"] += 1

        for path, (course_id, cmid, kind) in sorted(wanted.items()):
            full = ziel / path
            try:
                st = full.stat()
            except OSError:  # auf der Platte weg
                if path in known:
                    with con:
                        _drop_path(con, path)
                        con.execute("DELETE FROM files WHERE path=?", (path,))
                    cnt["removed"] += 1
                continue
            prev = known.get(path)
            if prev and prev[0] == st.st_mtime and prev[1] == st.st_size:
                if prev[3:] != (course_id, cmid):  # Aktivität umgezogen, Datei unverändert
                    with con:
                        con.execute("UPDATE entries SET course_id=?, cmid=? WHERE path=?", (course_id, cmid, path))
                        con.execute("UPDATE files SET course_id=?, cmid=? WHERE path=?", (course_id, cmid, path))
                cnt["unchanged"] += 1
                continue

            status, note, pages = "ok", "", []
            try:
                pages = extract(full, kind)
                if not pages:
                    status, note = "empty", "kein Text (gescannt?)"
            except Exception as e:  # kaputt, verschlüsselt, unbekanntes Format
                status, note = "error", f"{type(e).__name__}: {e}"[:200]
            with con:
                _drop_path(con, path)
                for page, text in pages:
                    _add(con, course_id, cmid, path, kind, Path(path).name, page, text)
                con.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?)",
                            (path, st.st_mtime, st.st_size, status, note, course_id, cmid))
            cnt["indexed"] += 1

        with con:
            con.execute("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)", (str(int(time.time())),))
        out = dict(cnt)
        for k in ("indexed", "unchanged", "removed"):
            out.setdefault(k, 0)
        out["entries"] = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        out["errors"] = con.execute("SELECT COUNT(*) FROM files WHERE status='error'").fetchone()[0]
        out["empty"] = con.execute("SELECT COUNT(*) FROM files WHERE status='empty'").fetchone()[0]
        out["seconds"] = round(time.time() - t0, 1)
        return out
    finally:
        con.close()


def stats(db: Path) -> dict:
    """Kurzstatus für `cli status`; legt nichts an."""
    db = Path(db)
    if not db.exists():
        return {"exists": False}
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        by = dict(con.execute("SELECT status, COUNT(*) FROM files GROUP BY status").fetchall())
        built = con.execute("SELECT value FROM meta WHERE key='built_at'").fetchone()
        return {"exists": True, "entries": con.execute("SELECT COUNT(*) FROM entries").fetchone()[0],
                "files": sum(by.values()), "errors": by.get("error", 0), "empty": by.get("empty", 0),
                "built_at": int(built[0]) if built else None, "size_bytes": os.path.getsize(db)}
    except sqlite3.DatabaseError:
        return {"exists": True, "broken": True}
    finally:
        con.close()


# --------------------------------------------------------------------------- Suche

def fts_query(q: str) -> str | None:
    """Nutzereingabe -> sichere FTS5-Anfrage: jedes Wort in Anführungszeichen (AND/OR/NEAR/( … sind dann nur Text)
    mit Präfix-Stern, damit Treffer schon beim Tippen erscheinen."""
    words = re.findall(r"[^\W_]+", norm(q).lower())
    return " ".join(f'"{w}"*' for w in words[:8]) or None


def search(db: Path, q: str, limit: int = 30) -> list[dict]:
    """Referenzabfrage (die App fragt in Rust genauso): Titel zählt zehnmal so viel wie der Text."""
    expr = fts_query(q)
    if not expr or not Path(db).exists():
        return []
    con = sqlite3.connect(f"file:{Path(db).as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT e.course_id, e.cmid, e.path, e.kind, e.title, e.page, snippet(fts, 1, ?, ?, '…', 14) "
            "FROM fts JOIN entries e ON e.id = fts.rowid WHERE fts MATCH ? ORDER BY bm25(fts, 10.0, 1.0) LIMIT ?",
            (MARK_OPEN, MARK_CLOSE, expr, limit)).fetchall()
    finally:
        con.close()
    keys = ("course_id", "cmid", "path", "kind", "title", "page", "snippet")
    return [dict(zip(keys, r)) for r in rows]
