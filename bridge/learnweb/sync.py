"""LearnWeb -> Obsidian. Spiegelt Dateien der aktuellen Kurse in den Vault und schreibt
Markdown-Übersichten (pro Kurs, "Neu", "Fristen").

    uv run python -m learnweb.sync             # synchronisieren
    uv run python -m learnweb.sync --dry-run   # nur zählen, nichts schreiben
    uv run python -m learnweb.sync --json      # JSON-Zeilen auf stdout (für die Desktop-App), Logzeilen auf stderr

Konfiguration: sync_config.json (wird beim ersten Lauf angelegt)
Zustand:       data/sync_state.json (bewusst NICHT im Vault)
Fristen:       data/deadlines.json (strukturiert, die App parst kein Markdown)
Termine:       data/events.json (Sitzungen, Fristen, Pruefungen aus Abschnittstiteln und Labels, siehe events.py)
Inhalte:       data/content.json (Ankuendigungen, Aufgaben, Dozenten; siehe learnweb/content.py)
Regeltermine:  data/schedule.json (Wochentag und Uhrzeit von Seminaren/Vorlesungen, erkannt; siehe learnweb/schedule.py)
Suchindex:     data/index.db (siehe learnweb/index.py), nach jedem erfolgreichen Sync aktualisiert
Verzeichnis:   _Verzeichnis.md und verzeichnis.json im Vault-Ordner (siehe learnweb/verzeichnis.py)

Rücksichtsvoll: eine Anfrage-Welle pro Lauf, Pause zwischen Anfragen, nur neue/geänderte Dateien.
Lokal gelöschte oder in LearnWeb entfernte Dateien werden nie gelöscht.
"""
from __future__ import annotations

import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import httpx

from . import content, credentials, events, index, schedule, suggest, verzeichnis
from .client import Credentials, FileTooLarge, LearnWeb, LearnWebError, LoginError, safe_filename, strip_html

# LEARNWEB_HOME: wohin `data/` und `sync_config.json` kommen (die mitgelieferte Brücke von Kursbuch liegt in einem schreibgeschützten Ordner);
# ohne die Variable wie bisher neben den Quellen
ROOT = Path(os.environ["LEARNWEB_HOME"]) if os.environ.get("LEARNWEB_HOME") else Path(__file__).resolve().parents[1]
CONFIG = ROOT / "sync_config.json"
STATE = ROOT / "data" / "sync_state.json"
LOCK = ROOT / "data" / "sync.lock"
DEADLINES = ROOT / "data" / "deadlines.json"
EVENTS = ROOT / "data" / "events.json"
CONTENT = ROOT / "data" / "content.json"
SCHEDULE = ROOT / "data" / "schedule.json"
SUGGESTIONS = ROOT / "data" / "suggestions.json"
INDEX = ROOT / "data" / "index.db"

JSON_MODE = False  # --json: stdout trägt nur JSON-Zeilen, Logzeilen gehen nach stderr

def documents_dir() -> Path:
    """Der Ordner „Dokumente“ des Nutzers, auch wenn er umgelegt ist (OneDrive, andere Sprache); sonst ~/Documents"""
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:  # 5 = CSIDL_PERSONAL
            return Path(buf.value)
    except Exception:  # noqa: BLE001
        pass
    return Path.home() / "Documents"


DEFAULT_CONFIG = {
    "ziel": str(documents_dir() / "Kursbuch" / "LearnWeb"),  # Nojos Vault steht ausdruecklich in seiner sync_config.json
    "kurse_ab": "auto",  # oder ein Datum JJJJ-MM-TT: Kurse, die ab dann beginnen (auto = Anfang des Vorsemesters)
    "kurse_extra": [],
    "kurse_aus": [],
    "max_mb": 20,
    "pause_s": 0.5,
}
FILE_TYPES = {"resource", "folder"}
ICON = {"resource": "📄", "folder": "📁", "url": "🔗", "page": "📃", "forum": "💬",
        "assign": "📝", "quiz": "❓", "scheduler": "📅", "label": "🏷️"}


# --------------------------------------------------------------------------- helpers

def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", file=sys.stderr if JSON_MODE else sys.stdout, flush=True)


def emit(event: str, **fields) -> None:
    """Eine JSON-Zeile für die App; ohne --json passiert nichts."""
    if JSON_MODE:
        print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def clean(name: str | None, maxlen: int) -> str:
    return safe_filename(strip_html(name) or "ohne Titel", maxlen)


def md_text(s: str) -> str:
    return s.replace("[", "(").replace("]", ")").replace("|", "/")


def md_link(text: str, target: str) -> str:
    return f"[{md_text(text)}](<{target}>)"


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def load_config() -> dict:
    if not CONFIG.exists():
        save_json(CONFIG, DEFAULT_CONFIG)
        log(f"Konfiguration angelegt: {CONFIG}")
    return {**DEFAULT_CONFIG, **load_json(CONFIG, {})}


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return  # unverändert -> kein unnötiger Obsidian-Sync
    path.write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- kurse

def auto_since(today: "time.struct_time | None" = None) -> str:
    """Beginn der Kurse, die zu sehen sein sollen: einen Monat vor dem Vorsemester (Semester beginnen am 1.4. und 1.10.;
    Kurse werden meist schon im Vormonat angelegt). Oktober 2026 -> 2026-03-01, Maerz 2027 -> 2026-09-01."""
    t = today or time.localtime()
    y, m = t.tm_year, t.tm_mon
    # aktuelles Semester: WiSe ab 1.10., SoSe ab 1.4.; das Vorsemester beginnt ein halbes Jahr davor
    start_y, start_m = (y, 10) if m >= 10 else (y, 4) if m >= 4 else (y - 1, 10)
    prev_y, prev_m = (start_y, start_m - 6) if start_m == 10 else (start_y - 1, 10)
    # ein Monat Vorlauf
    py, pm = (prev_y, prev_m - 1)
    return f"{py:04d}-{pm:02d}-01"


def select_courses(lw: LearnWeb, cfg: dict) -> list[dict]:
    data = lw.ajax("core_course_get_enrolled_courses_by_timeline_classification",
                   {"classification": "all", "limit": 0, "offset": 0, "sort": "fullname"})
    since = auto_since() if str(cfg["kurse_ab"]).strip().lower() == "auto" else cfg["kurse_ab"]
    ab = int(time.mktime(time.strptime(since, "%Y-%m-%d")))
    extra, aus = set(map(int, cfg["kurse_extra"])), set(map(int, cfg["kurse_aus"]))
    out = [c for c in data.get("courses", [])
           if (c.get("startdate", 0) >= ab or c["id"] in extra) and c["id"] not in aus and not c.get("hidden")]
    return sorted(out, key=lambda c: strip_html(c["fullname"]).lower())


# --------------------------------------------------------------------------- markdown

def course_note(entry: dict, stamp: str) -> str:
    cdir = entry["dir"]
    lines = ["---", f"learnweb_id: {entry['id']}", f"learnweb_url: {entry['url']}",
             f"letzter_sync: {stamp}", "tags: [learnweb]", "---", "",
             f"# {entry['name']}", "", f"[In LearnWeb öffnen]({entry['url']})", ""]
    for title, cmids in entry["layout"]:
        lines.append(f"## {md_text(title)}")
        if not cmids:
            lines.append("_(nur Beschreibungstext, siehe LearnWeb)_")
        for k in cmids:
            cm = entry["cms"][k]
            icon = ICON.get(cm["typ"], "▫️")
            # relpath statt relative_to: übersteht umbenannte Kurse (alte Dateien liegen dann in ../Altname)
            files = [os.path.relpath(f, cdir).replace("\\", "/") for f in cm.get("files", [])]
            if cm["typ"] == "resource" and len(files) == 1:
                lines.append(f"- {icon} {md_link(cm['name'], files[0])}")
            else:
                lines.append(f"- {icon} [{md_text(cm['name'])}]({cm['url']})" if cm.get("url") else f"- {icon} {md_text(cm['name'])}")
                for f in files if cm["typ"] == "folder" else []:
                    lines.append(f"    - {md_link(Path(f).name, f)}")
            for s in cm.get("skipped", []):
                lines.append(f"    - ⚠️ Datei zu groß ({s['mb']} MB), nicht gespiegelt – im LearnWeb öffnen")
            if cm.get("error"):
                lines.append(f"    - ⚠️ Download fehlgeschlagen, nächster Lauf versucht es erneut")
        lines.append("")
    return "\n".join(lines)


def digest_note(digest: list[dict], stamp: str) -> str:
    lines = ["---", f"letzter_sync: {stamp}", "tags: [learnweb]", "---", "",
             "# LearnWeb – Neu", "", "Neueste Änderungen zuerst. Wird bei jedem Sync aktualisiert.", ""]
    if not digest:
        lines.append("_Noch keine Änderungen seit dem Erstimport._")
    for d in digest:
        lines += [f"## {d['zeit']}", *d["lines"], ""]
    return "\n".join(lines)


def deadlines_note(deadlines: list[dict], stamp: str) -> str:
    lines = ["---", f"letzter_sync: {stamp}", "tags: [learnweb]", "---", "",
             "# LearnWeb – Fristen", "", "| Fällig | Was | Kurs |", "|---|---|---|"]
    for d in deadlines:
        mark = "⚠️ " if d["ueberfaellig"] else ""
        what = f"[{md_text(d['titel'])}]({d['url']})" if d.get("url") else md_text(d["titel"])
        lines.append(f"| {mark}{d['faellig']} | {what} ({d.get('was') or d.get('typ') or ''}) | {md_text(d['kurs'])} |")
    if not deadlines:
        lines.append("| – | keine Fristen in den nächsten 180 Tagen | |")
    return "\n".join(lines) + "\n"


def overview_note(entries: list[dict], stamp: str) -> str:
    lines = ["---", f"letzter_sync: {stamp}", "tags: [learnweb]", "---", "", "# LearnWeb", "",
             "- [[_Neu]] · [[_Fristen]] · [[_Verzeichnis]]", "", "## Kurse"]
    for e in entries:
        n_files = sum(len(cm.get("files", [])) for cm in e["cms"].values())
        lines.append(f"- {md_link(e['name'], e['dir'] + '/' + e['dir'] + '.md')} · {n_files} Dateien")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- sync

def sync_course(lw, c, old, ziel, since, cfg, dry, totals, now: int | None = None) -> tuple[dict, list[str]]:
    now = now or int(time.time())
    pause, max_bytes = cfg["pause_s"], int(cfg["max_mb"] * 1e6)
    raw = lw.ajax("core_courseformat_get_state", {"courseid": c["id"]})
    st = json.loads(raw) if isinstance(raw, str) else raw
    cdir = clean(c["fullname"], 50)
    old_cms = old.get("cms", {})
    course_first = not old

    changed: set[str] = set()
    if since and not course_first:
        time.sleep(pause)
        try:
            upd = lw.ajax("core_course_get_updates_since", {"courseid": c["id"], "since": since})
            for inst in upd.get("instances", []):
                if inst.get("contextlevel") == "module" and any(
                        u.get("name") in ("contentfiles", "configuration") for u in inst.get("updates", [])):
                    changed.add(str(inst["id"]))
        except LearnWebError as e:
            log(f"  updates_since nicht verfügbar ({e}) – nur neue Inhalte werden erkannt")

    cms = {str(x["id"]): x for x in st.get("cm", [])}
    sections = {str(s["id"]): s for s in st.get("section", [])}
    order = st.get("course", {}).get("sectionlist") or list(sections)

    entry = {"id": c["id"], "name": strip_html(c["fullname"]), "url": c.get("viewurl"), "dir": cdir,
             "cms": {}, "layout": []}
    report: list[str] = []
    n_new_files = 0

    for sid in order:
        s = sections.get(str(sid))
        if not s:
            continue
        title = strip_html(s.get("title")) or f"Abschnitt {s.get('number')}"
        sdir = clean(f"{int(s.get('number') or 0):02d} {title}", 40)
        items = []
        for cmid in s.get("cmlist", []):
            cm = cms.get(str(cmid))
            if not cm or not cm.get("uservisible", True):
                continue
            k, typ, name = str(cm["id"]), cm.get("module") or cm.get("modname"), strip_html(cm.get("name"))
            prev = old_cms.get(k, {})
            rec = {"name": name, "typ": typ, "section": sdir, "url": cm.get("url"),
                   "files": prev.get("files", []), "skipped": prev.get("skipped", [])}
            # seen_at = erstes Auftauchen, updated_at = letzte Dateiaktualisierung (Unix-Zeit). Fehlt ein Feld in
            # alten Daten, gilt die Aktivität als alt; der Erstimport (since is None) zählt nie als neu.
            for f in ("seen_at", "updated_at"):
                if f in prev:
                    rec[f] = prev[f]
            is_new = k not in old_cms
            if is_new and since:
                rec["seen_at"] = now
            needs = typ in FILE_TYPES and (is_new or k in changed or (not rec["files"] and not rec["skipped"]))

            if needs and dry:
                totals["würde laden"] += 1
            elif needs:
                dest = ziel / cdir / sdir
                if typ == "folder":
                    dest = dest / clean(name, 40)
                time.sleep(pause)
                try:
                    paths = lw.download(int(k), typ, dest, max_bytes)
                    rec["files"] = sorted({p.relative_to(ziel).as_posix() for p in paths})
                    rec["skipped"] = [{"mb": round(e.size / 1e6, 1)} for e in getattr(lw, "last_skipped", [])]
                    totals["Dateien"] += len(paths)
                    n_new_files += len(paths)
                    if not is_new:
                        rec["updated_at"] = now
                    for p in rec["files"]:
                        emit("file", course=entry["name"], name=name, path=p, new=is_new)
                except FileTooLarge as e:
                    rec["files"], rec["skipped"] = [], [{"mb": round(e.size / 1e6, 1)}]
                except (LearnWebError, httpx.HTTPError, OSError) as e:
                    rec["error"] = str(e)[:200]
                    totals["Fehler"] += 1
                    log(f"  Fehler bei '{name}': {rec['error']}")
                totals["zu groß"] += len(rec["skipped"])

            if not course_first and not dry:
                first_file = rec["files"][0] if rec["files"] else None
                label = md_link(name, first_file) if first_file else (f"[{md_text(name)}]({rec['url']})" if rec["url"] else md_text(name))
                if is_new:
                    report.append(f"- 🆕 {ICON.get(typ, '▫️')} {label}")
                elif k in changed and typ in FILE_TYPES:
                    report.append(f"- 🔄 {ICON.get(typ, '▫️')} {label} (aktualisiert)")
                elif prev.get("name") and prev["name"] != name:
                    report.append(f"- ✏️ {label} (umbenannt, vorher: {md_text(prev['name'])})")

            entry["cms"][k] = rec
            items.append(k)
        if items or s.get("hassummary"):
            entry["layout"].append((title, items))

    if not course_first and not dry:
        for k, cm in old_cms.items():
            if k not in entry["cms"]:
                report.append(f"- 🗑️ {md_text(cm['name'])} (in LearnWeb entfernt, lokale Dateien bleiben)")
    if course_first and not dry:
        report.append(f"- ➕ Kurs neu aufgenommen: {n_new_files} Dateien")
    return entry, report


def pid_alive(pid: int) -> bool:
    """Lebt der Prozess noch? (Unter Windows kein os.kill(pid, 0): 0 ist dort CTRL_C_EVENT.)"""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ctypes.get_last_error() == 5  # ACCESS_DENIED: den Prozess gibt es, er gehört nur jemand anderem
    try:
        code = wintypes.DWORD()
        return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


def lock_active() -> bool:
    """Läuft ein Sync? Die Sperre gilt höchstens 2 h und nur, solange ihr Prozess lebt (Absturz = kein Dauer-Lock)."""
    try:
        age = time.time() - LOCK.stat().st_mtime
    except FileNotFoundError:
        return False
    if age >= 2 * 3600:
        return False
    try:
        pid = int(LOCK.read_text())
    except (ValueError, OSError):
        return True  # unlesbar: lieber vorsichtig bleiben
    return pid_alive(pid)


def acquire_lock() -> bool:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    if lock_active():
        return False
    LOCK.write_text(str(os.getpid()))
    return True


def run(dry: bool = False) -> int:
    if not dry and not acquire_lock():
        log("Ein anderer Sync läuft noch (data/sync.lock). Abbruch.")
        emit("error", code="locked", message="Ein anderer Sync läuft noch (data/sync.lock).")
        return 2
    try:
        cfg = load_config()
        state = load_json(STATE, {"last_run": None, "courses": {}, "digest": []})
        ziel = Path(cfg["ziel"])
        user = credentials.username()
        lw = LearnWeb(Credentials(user, lambda: credentials.password(user)))
        started, since = int(time.time()), state.get("last_run")
        stamp = time.strftime("%Y-%m-%d %H:%M")
        totals: Counter = Counter()

        courses = select_courses(lw, cfg)
        log(f"{len(courses)} Kurse ab {cfg['kurse_ab']} → {ziel}{' (Probelauf)' if dry else ''}")
        emit("start", courses=len(courses), dry=dry)
        digest_lines: list[str] = []
        entries = []
        for i, c in enumerate(courses, 1):
            time.sleep(cfg["pause_s"])
            old = state["courses"].get(str(c["id"]), {})
            entry, report = sync_course(lw, c, old, ziel, since, cfg, dry, totals, now=started)
            entries.append(entry)
            n = sum(len(cm["files"]) for cm in entry["cms"].values())
            log(f"  {entry['name'][:60]:60} {len(entry['cms']):3} Aktivitäten, {n:3} Dateien")
            emit("course", index=i, total=len(courses), id=c["id"], name=entry["name"],
                 activities=len(entry["cms"]), files=n)
            if dry:
                continue
            write_text(ziel / entry["dir"] / f"{entry['dir']}.md", course_note(entry, stamp))
            state["courses"][str(c["id"])] = entry
            save_json(STATE, state)  # nach jedem Kurs sichern
            if report and since:
                digest_lines += [f"### {md_link(entry['name'], entry['dir'] + '/' + entry['dir'] + '.md')}", *report]

        if dry:
            log(f"Probelauf: {totals['würde laden']} Aktivitäten mit Dateien würden geladen.")
            emit("done", dry=True, would_load=totals["würde laden"])
            return 0

        if not since:
            digest_lines = [f"- Erstimport: {len(courses)} Kurse, {totals['Dateien']} Dateien"
                            + (f", {totals['zu groß']} zu groß übersprungen" if totals["zu groß"] else "")]
        if digest_lines:
            state["digest"] = ([{"zeit": stamp, "lines": digest_lines}] + state.get("digest", []))[:40]
        write_text(ziel / "_Neu.md", digest_note(state["digest"], stamp))
        time.sleep(cfg["pause_s"])
        deadlines = lw.deadlines(days=180)
        write_text(ziel / "_Fristen.md", deadlines_note(deadlines, stamp))
        save_json(DEADLINES, {"updated": started, "items": deadlines})
        write_text(ziel / "_LearnWeb.md", overview_note(entries, stamp))

        state["last_run"] = started
        save_json(STATE, state)
        n_changes = sum(1 for line in digest_lines if line.startswith("- ")) if since else 0
        try:  # Inhalte ohne Datei (content.py): Ankuendigungen, Aufgaben, Dozenten; darf einen geglueckten Sync nie kippen
            emit("content", **content.update(lw, state, lambda: load_json(CONTENT, {}), lambda d: save_json(CONTENT, d), cfg["pause_s"], started))
        except Exception as e:
            log(f"Inhalte nicht aktualisiert: {type(e).__name__}: {e}")
            emit("content", error=f"{type(e).__name__}: {e}"[:200])
        try:  # Termine aus Abschnittstiteln und Labels (events.py); darf einen geglueckten Sync nie kippen
            items = events.build(state)
            save_json(EVENTS, {"updated": started, "items": items})
            emit("events", count=len(items))
            try:  # Regeltermine (Wochentag, Uhrzeit) aus Sitzungen und Texten (schedule.py)
                emit("schedule", **schedule.update(state, items, load_json(CONTENT, {}), lambda d: save_json(SCHEDULE, d), started))
            except Exception as e:
                log(f"Regeltermine nicht erkannt: {type(e).__name__}: {e}")
                emit("schedule", error=f"{type(e).__name__}: {e}"[:200])
        except Exception as e:
            log(f"Termine nicht aktualisiert: {type(e).__name__}: {e}")
            emit("events", error=f"{type(e).__name__}: {e}"[:200])
        try:
            emit("index", **index.update(state, ziel, INDEX, content=load_json(CONTENT, {})))
        except Exception as e:  # der Suchindex darf einen geglückten Sync nie kippen
            log(f"Suchindex nicht aktualisiert: {type(e).__name__}: {e}")
            emit("index", error=f"{type(e).__name__}: {e}"[:200])
        try:  # Vorschlaege fuer Termine und Fristen aus den Kurstexten (suggest.py), nach dem Index; nur Vorschlaege, nie Termine
            emit("suggest", **suggest.update(state, load_json(EVENTS, {}).get("items", []), load_json(DEADLINES, {}).get("items", []), INDEX,
                                             lambda d: save_json(SUGGESTIONS, d), started))
        except Exception as e:
            log(f"Vorschläge nicht erstellt: {type(e).__name__}: {e}")
            emit("suggest", error=f"{type(e).__name__}: {e}"[:200])
        try:  # Verzeichnis für Menschen und KI (verzeichnis.py), nach dem Index (Seitenzahlen, Textanfang)
            emit("verzeichnis", **verzeichnis.update(state, ziel, INDEX, write_text, stamp))
        except Exception as e:
            log(f"Verzeichnis nicht aktualisiert: {type(e).__name__}: {e}")
            emit("verzeichnis", error=f"{type(e).__name__}: {e}"[:200])
        log(f"Fertig: {totals['Dateien']} Dateien geladen, {totals['zu groß']} zu groß, "
            f"{totals['Fehler']} Fehler, {n_changes} Änderungen gemeldet.")
        emit("done", files=totals["Dateien"], skipped=totals["zu groß"], errors=totals["Fehler"], changes=n_changes)
        return 1 if totals["Fehler"] else 0
    except LearnWebError as e:
        log(f"ABBRUCH: {e}")
        emit("error", code="login" if isinstance(e, LoginError) else "learnweb", message=str(e))
        return 1
    finally:
        if not dry:
            LOCK.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    global JSON_MODE
    JSON_MODE = "--json" in argv
    if JSON_MODE:  # Pipe zur App: immer UTF-8, nicht die Codepage der Konsole
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        return run(dry="--dry-run" in argv)
    except Exception as e:
        if not JSON_MODE:
            raise  # ohne --json bleibt alles wie bisher (Traceback, Exitcode 1)
        code = ("credentials" if isinstance(e, credentials.NoCredentials)
                else "network" if isinstance(e, httpx.HTTPError) else "internal")
        emit("error", code=code, message=f"{type(e).__name__}: {e}"[:300])
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
