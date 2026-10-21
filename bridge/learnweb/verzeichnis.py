"""Verzeichnis aller Kurse und Dateien: Einstieg fuer Menschen und fuer KI-Assistenten (Claude, ChatGPT, Claude Code).

    uv run python -m learnweb.cli verzeichnis      # aus State und Suchindex neu bauen, kein LearnWeb-Zugriff

Schreibt in den LearnWeb-Ordner des Vaults (`ziel`):
    _Verzeichnis.md    zum Lesen und zum Hineinkopieren in einen Chat: nach Semester, Kurs, Abschnitt; je Datei Typ, Seiten,
                       Groesse und der Anfang des Textes
    verzeichnis.json   dasselbe maschinenlesbar (Schema unten)
Pfade sind relativ zu `ziel`. Beide Dateien entstehen beim Sync (nach dem Index) und werden nur geschrieben, wenn sich ihr
Inhalt aendert.

verzeichnis.json:
    {"erzeugt": "2026-10-14 13:40", "ordner": "<ziel>", "hinweis": "...",
     "semester": [{"name": "WiSe 2026/27", "kurse": [{
        "id", "name" (voller LearnWeb-Name), "titel", "dozent", "url", "notiz" (Pfad der Obsidian-Notiz),
        "abschnitte": [{"titel", "datum" (ISO oder null), "eintraege": [
            {"cmid", "typ", "name", "url", "dateien": [{"pfad", "name", "ext", "bytes", "seiten", "text": "ja"|"leer"|"fehler",
                                                         "anfang"}], "zu_gross_mb": [..]}      # Label: {"typ": "label", "text"}
        ]}]}]}]}
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import date
from pathlib import Path
from typing import Callable

from . import events

HINWEIS = ("Alle Kurse und Dateien aus LearnWeb, nach Semester, Kurs und Abschnitt geordnet. Pfade sind relativ zu diesem Ordner. "
           "Von der Synchronisierung erzeugt, nicht von Hand ändern.")
ICON = {"resource": "📄", "folder": "📁", "url": "🔗", "page": "📃", "forum": "💬", "assign": "📝", "quiz": "❓",
        "scheduler": "📅", "opencast": "🎬", "zoom": "🎥", "h5pactivity": "🧩"}
_SEM = re.compile(r"(?<![A-Za-z])(WiSe|SoSe)\s+(\d{4})(?:[/-]\d{2}(?:\d{2})?)?")
_TEXT_KINDS = ("pdf", "docx", "pptx")


def semester_label(term: str, year: int) -> str:
    return f"WiSe {year}/{(year + 1) % 100:02d}" if term == "WiSe" else f"SoSe {year}"


def split_name(full: str) -> tuple[str, str | None, str | None]:
    """"Gulliver's Travels at 300 WiSe 2026/27, Kirsten Juhas" -> ("Gulliver's Travels at 300", "WiSe 2026/27", "Kirsten Juhas")"""
    full = " ".join(full.split())
    m = _SEM.search(full)
    if not m:
        return full, None, None
    before, after = full[:m.start()].rstrip(), full[m.end():].strip()
    teacher = after[1:].strip() or None if after.startswith(",") else None
    rest = "" if after.startswith(",") else after
    return " ".join(p for p in (before, rest) if p) or full, semester_label(m[1], int(m[2])), teacher


def _rank(sem: str) -> int:
    m = re.match(r"(WiSe|SoSe) (\d{4})", sem)
    return int(m[2]) * 2 + (m[1] == "WiSe") if m else 0


def _size(b: int | None) -> str:
    if b is None:
        return "?"
    return f"{b / 1e6:.1f} MB" if b >= 1e6 else f"{max(1, round(b / 1e3))} KB"


def _index_info(db: Path | None) -> dict[str, dict]:
    """Seiten, Textstatus und Textanfang je Datei aus dem Suchindex (fehlt er, bleibt es leer)."""
    if not db or not Path(db).exists():
        return {}
    con = sqlite3.connect(f"file:{Path(db).as_posix()}?mode=ro", uri=True)
    try:
        info = {p: {"status": s, "note": n} for p, s, n in con.execute("SELECT path, status, note FROM files")}
        for p, pages in con.execute("SELECT path, MAX(page) FROM entries WHERE page IS NOT NULL GROUP BY path"):
            info.setdefault(p, {})["seiten"] = pages
        kinds = ",".join(f"'{k}'" for k in _TEXT_KINDS)
        for p, body in con.execute(f"SELECT e.path, f.body FROM entries e JOIN fts f ON f.rowid = e.id WHERE e.id IN "
                                   f"(SELECT MIN(id) FROM entries WHERE kind IN ({kinds}) GROUP BY path)"):
            info.setdefault(p, {})["anfang"] = (body[:157].rstrip() + "…") if len(body) > 160 else body
        return info
    except sqlite3.DatabaseError:
        return {}
    finally:
        con.close()


def build(state: dict, ziel: Path, db: Path | None = None, stand: str | None = None) -> dict:
    ziel, info = Path(ziel), _index_info(db)
    today = date.today()
    by_sem: dict[str, list] = {}
    for c in state.get("courses", {}).values():
        titel, sem, dozent = split_name(c.get("name", ""))
        sem_tuple = events.semester_of(c.get("name", ""))
        abschnitte = []
        for stitle, ids in c.get("layout", []):
            hits = events.find_dates(stitle or "")
            d = events.resolve(hits[0], sem_tuple, today) if hits else None
            eintraege = []
            for k in ids:
                cm = c.get("cms", {}).get(k)
                if not cm:
                    continue
                if cm.get("typ") == "label":
                    eintraege.append({"cmid": int(k), "typ": "label", "text": cm.get("name", "")})
                    continue
                dateien = []
                for f in cm.get("files", []):
                    try:
                        size = (ziel / f).stat().st_size
                    except OSError:
                        size = None
                    i = info.get(f, {})
                    dateien.append({"pfad": f, "name": f.rsplit("/", 1)[-1], "ext": f.rsplit(".", 1)[-1].lower() if "." in f else "",
                                    "bytes": size, "seiten": i.get("seiten"),
                                    "text": {"ok": "ja", "empty": "leer", "error": "fehler"}.get(i.get("status"), None),
                                    "anfang": i.get("anfang")})
                e = {"cmid": int(k), "typ": cm.get("typ"), "name": cm.get("name", ""), "url": cm.get("url"), "dateien": dateien}
                if cm.get("skipped"):
                    e["zu_gross_mb"] = [s.get("mb") for s in cm["skipped"]]
                eintraege.append(e)
            abschnitte.append({"titel": stitle, "datum": d.isoformat() if d else None, "eintraege": eintraege})
        by_sem.setdefault(sem or "Weitere", []).append({
            "id": c["id"], "name": c.get("name", ""), "titel": titel, "dozent": dozent, "url": c.get("url"),
            "notiz": f"{c['dir']}/{c['dir']}.md" if c.get("dir") else None, "abschnitte": abschnitte})
    semester = [{"name": s, "kurse": sorted(k, key=lambda c: c["titel"].lower())}
                for s, k in sorted(by_sem.items(), key=lambda kv: (-_rank(kv[0]), kv[0]))]
    return {"erzeugt": stand or time.strftime("%Y-%m-%d %H:%M"), "ordner": str(ziel), "hinweis": HINWEIS, "semester": semester}


def _md_link(text: str, target: str) -> str:
    return f"[{text.replace('[', '(').replace(']', ')').replace('|', '/')}](<{target}>)"


def markdown(v: dict) -> str:
    n_kurse = sum(len(s["kurse"]) for s in v["semester"])
    n_dateien = sum(len(e.get("dateien", [])) for s in v["semester"] for c in s["kurse"] for a in c["abschnitte"] for e in a["eintraege"])
    out = ["---", f"erzeugt: {v['erzeugt']}", "tags: [learnweb, verzeichnis]", "---", "", "# LearnWeb – Verzeichnis", "",
           f"> {v['hinweis']}", ">",
           "> Für KI-Assistenten: Dieses Verzeichnis ist der Einstieg. Aufbau der Dateien: `<Kurs>/<NN Abschnitt>/<Datei>`; je Kurs gibt es eine",
           "> Notiz `<Kurs>/<Kurs>.md`. Dieselben Angaben maschinenlesbar in `verzeichnis.json`. „Text: leer“ heißt, die Datei hat keinen",
           "> lesbaren Text (gescannt); „zu groß“ heißt, sie wurde nicht gespiegelt und liegt nur in LearnWeb.", "",
           f"{len(v['semester'])} Semester · {n_kurse} Kurse · {n_dateien} Dateien", ""]
    for s in v["semester"]:
        out += [f"## {s['name']}", ""]
        for c in s["kurse"]:
            head = f"### {c['titel']}" + (f" — {c['dozent']}" if c["dozent"] else "")
            links = [x for x in ((f"[LearnWeb]({c['url']})" if c["url"] else None), (f"Notiz: {_md_link(c['titel'], c['notiz'])}" if c["notiz"] else None)) if x]
            out += [head, "", " · ".join(links) + (f" · Kurs-ID {c['id']}" if links else f"Kurs-ID {c['id']}"), ""]
            for a in c["abschnitte"]:
                if not a["eintraege"]:
                    continue
                out.append(f"**{a['titel']}**" + (f" ({a['datum']})" if a["datum"] else ""))
                for e in a["eintraege"]:
                    if e["typ"] == "label":
                        out.append(f"- {e['text']}")
                        continue
                    icon = ICON.get(e["typ"], "▫️")
                    if not e["dateien"]:
                        out.append(f"- {icon} {_md_link(e['name'], e['url']) if e.get('url') else e['name']}"
                                   + (f" — zu groß ({', '.join(f'{m} MB' for m in e['zu_gross_mb'])}), nur in LearnWeb" if e.get("zu_gross_mb") else ""))
                        continue
                    if len(e["dateien"]) > 1:
                        out.append(f"- {icon} {e['name']}")
                    for d in e["dateien"]:
                        meta = [d["ext"].upper() or "Datei", *([f"{d['seiten']} S."] if d["seiten"] else []), _size(d["bytes"])]
                        if d["text"] == "leer":
                            meta.append("Text: leer")
                        elif d["text"] == "fehler":
                            meta.append("Text: nicht lesbar")
                        line = f"{_md_link(d['name'] if len(e['dateien']) > 1 else e['name'], d['pfad'])} — {' · '.join(meta)}"
                        if d["anfang"]:
                            line += f" — „{d['anfang']}“"
                        out.append(("  - " if len(e["dateien"]) > 1 else f"- {icon} ") + line)
                out.append("")
    return "\n".join(out).rstrip() + "\n"


_STAMP = re.compile(r'^erzeugt: .*$|"erzeugt": "[^"]*"', re.M)


def _write_if_changed(path: Path, text: str, write: Callable[[Path, str], None]) -> bool:
    """Nur schreiben, wenn sich mehr als der Zeitstempel geaendert hat (sonst synchronisiert Obsidian bei jedem Sync neu)."""
    try:
        if _STAMP.sub("", path.read_text(encoding="utf-8")) == _STAMP.sub("", text):
            return False
    except OSError:
        pass
    write(path, text)
    return True


def update(state: dict, ziel: Path, db: Path | None, write: Callable[[Path, str], None], stand: str | None = None) -> dict:
    """Verzeichnis neu bauen und bei Aenderung schreiben. `write` ist sync.write_text."""
    v = build(state, ziel, db, stand)
    ziel = Path(ziel)
    changed = _write_if_changed(ziel / "_Verzeichnis.md", markdown(v), write)
    changed |= _write_if_changed(ziel / "verzeichnis.json", json.dumps(v, ensure_ascii=False, indent=1) + "\n", write)
    return {"semester": len(v["semester"]), "kurse": sum(len(s["kurse"]) for s in v["semester"]), "geschrieben": changed}
