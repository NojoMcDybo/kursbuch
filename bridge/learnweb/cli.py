"""Schmale Brücke für die Desktop-App (Kursbuch). Ausgabe immer JSON auf stdout, Exitcodes: 0 ok, 1 Fehler, 2 läuft schon.

    uv run python -m learnweb.cli status
    uv run python -m learnweb.cli sync [--dry-run]     # JSON-Zeilen, siehe learnweb/sync.py
    uv run python -m learnweb.cli index [--rebuild]
    uv run python -m learnweb.cli events               # Termine aus dem State neu bauen (data/events.json)
    uv run python -m learnweb.cli verzeichnis          # _Verzeichnis.md + verzeichnis.json im Vault neu bauen
    uv run python -m learnweb.cli fetch <kurs> <cmid> [--all-sizes]   # eine Datei/einen Ordner sofort laden
    uv run python -m learnweb.cli schedule             # Regeltermine (Wochentag/Uhrzeit) neu erkennen (data/schedule.json), ohne LearnWeb-Zugriff
    uv run python -m learnweb.cli suggest              # Vorschlaege fuer Termine/Fristen aus den Kurstexten (data/suggestions.json), ohne LearnWeb-Zugriff
    uv run python -m learnweb.cli selftest [--net]      # prueft ohne Netz, ob alles da ist (Tresor, Zertifikate, Suche, PDF/DOCX/PPTX); fuer die mitgelieferte .exe
    uv run python -m learnweb.cli content [--force]    # Ankuendigungen, Aufgaben, Dozenten auffrischen (data/content.json)
    uv run python -m learnweb.cli login <kennung> [--no-save]   # Passwort als erste Zeile von stdin, nie als Argument; --no-save prueft nur
    uv run python -m learnweb.cli --password-stdin <befehl>      # Passwort dieser Sitzung (erste Zeile von stdin) statt des gespeicherten
    uv run python -m learnweb.cli logout               # gespeicherte Zugangsdaten loeschen
    uv run python -m learnweb.cli config get [schluessel]
    uv run python -m learnweb.cli config set <schluessel> <wert>

Die App kennt keine Passwörter: `login` prüft sie bei LearnWeb und legt sie erst bei Erfolg in der Windows-
Anmeldeinformationsverwaltung ab (ein falsches Passwort überschreibt also nie ein funktionierendes).
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import httpx

from . import content, credentials, events, fetch, index, schedule, suggest, sync, verzeichnis
from .client import Credentials, LearnWeb, LearnWebError, LoginError

_TRANSPORT: httpx.BaseTransport | None = None  # nur für Tests (simuliertes LearnWeb)


def out(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def config() -> dict:
    return {**sync.DEFAULT_CONFIG, **sync.load_json(sync.CONFIG, {})}


# --------------------------------------------------------------------------- config

def _number(lo: float, hi: float):
    def check(v):
        x = float(v)
        if not lo <= x <= hi:
            raise ValueError(f"muss zwischen {lo:g} und {hi:g} liegen")
        return int(x) if x == int(x) else x
    return check


def _ziel(v) -> str:
    p = Path(str(v))
    if not p.is_absolute():
        raise ValueError("muss ein absoluter Pfad sein")
    if p.exists() and not p.is_dir():
        raise ValueError("ist eine Datei, kein Ordner")
    return str(p)


def _datum(v) -> str:
    if str(v).strip().lower() == "auto":  # Anfang des Vorsemesters, rechnet sich selbst fort (sync.auto_since)
        return "auto"
    time.strptime(str(v), "%Y-%m-%d")
    return str(v)


def _ids(v) -> list[int]:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            v = [x for x in re.split(r"[,\s]+", v) if x]
    if isinstance(v, int) and not isinstance(v, bool):
        v = [v]
    if not isinstance(v, list) or any(isinstance(x, bool) for x in v):
        raise ValueError("muss eine Liste von Kurs-IDs sein")
    return sorted({int(x) for x in v})


# pause_s hat eine Untergrenze: die Rücksicht auf LearnWeb soll sich nicht aus Versehen abschalten lassen
VALIDATORS = {"ziel": _ziel, "kurse_ab": _datum, "kurse_extra": _ids, "kurse_aus": _ids,
              "max_mb": _number(1, 500), "pause_s": _number(0.2, 10)}


def cmd_config(args) -> int:
    cfg = config()
    if args.action == "get":
        if args.key and args.key not in cfg:
            out({"ok": False, "error": f"Unbekannter Schlüssel: {args.key}"})
            return 1
        out({"ok": True, "config": cfg if not args.key else {args.key: cfg[args.key]}})
        return 0
    if args.key not in VALIDATORS:
        out({"ok": False, "error": f"Unbekannter Schlüssel: {args.key}"})
        return 1
    try:
        value = VALIDATORS[args.key](args.value)
    except (ValueError, TypeError) as e:
        out({"ok": False, "error": f"{args.key}: {e}"})
        return 1
    cfg[args.key] = value
    sync.save_json(sync.CONFIG, cfg)
    out({"ok": True, "key": args.key, "value": value})
    return 0


# --------------------------------------------------------------------------- status

def cmd_status(args) -> int:
    state = sync.load_json(sync.STATE, {})
    deadlines = sync.load_json(sync.DEADLINES, None)
    lock = None
    try:
        lock = {"pid": int(sync.LOCK.read_text()), "age_s": int(time.time() - sync.LOCK.stat().st_mtime)}
    except (OSError, ValueError):
        pass
    user = credentials.stored()
    out({"last_run": state.get("last_run"), "running": sync.lock_active(), "lock": lock,
         "courses": len(state.get("courses", {})),
         "deadlines": None if deadlines is None else {"updated": deadlines.get("updated"), "count": len(deadlines.get("items", []))},
         "config": config(), "index": index.stats(sync.INDEX), "login": {"saved": user is not None, "user": user}})
    return 0


# --------------------------------------------------------------------------- sync / index / login

def cmd_sync(args) -> int:
    return sync.main(["--json"] + (["--dry-run"] if args.dry_run else []))


def cmd_index(args) -> int:
    state = sync.load_json(sync.STATE, None)
    if not state:
        out({"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."})
        return 1
    if not sync.acquire_lock():
        out({"ok": False, "code": "locked", "error": "Ein Sync läuft gerade."})
        return 2
    try:
        out({"ok": True, **index.update(state, Path(config()["ziel"]), sync.INDEX, rebuild=args.rebuild)})
        return 0
    finally:
        sync.LOCK.unlink(missing_ok=True)


def cmd_events(args) -> int:
    """Termine aus dem State neu bauen (kein LearnWeb-Zugriff, kein Sync noetig)."""
    state = sync.load_json(sync.STATE, None)
    if not state:
        out({"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."})
        return 1
    items = events.build(state)
    sync.save_json(sync.EVENTS, {"updated": int(time.time()), "items": items})
    kinds: dict[str, int] = {}
    for e in items:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    out({"ok": True, "count": len(items), "kinds": kinds})
    return 0


def cmd_verzeichnis(args) -> int:
    """Verzeichnis (_Verzeichnis.md, verzeichnis.json) aus State und Suchindex neu bauen, ohne LearnWeb-Zugriff."""
    state = sync.load_json(sync.STATE, None)
    if not state:
        out({"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."})
        return 1
    out({"ok": True, **verzeichnis.update(state, Path(config()["ziel"]), sync.INDEX, sync.write_text)})
    return 0


def cmd_fetch(args) -> int:
    code, res = fetch.fetch(args.course, args.cmid, args.all_sizes)
    out(res)
    return code


def cmd_login(args) -> int:
    pw = sys.stdin.readline().rstrip("\r\n")
    if not pw:
        out({"ok": False, "error": "Kein Passwort auf stdin."})
        return 1
    try:
        LearnWeb(Credentials(args.user, lambda: pw), transport=_TRANSPORT).login()
    except LearnWebError as e:
        out({"ok": False, "error": str(e)})
        return 1
    except httpx.HTTPError:
        out({"ok": False, "error": "LearnWeb ist nicht erreichbar."})
        return 1
    if not args.no_save:
        credentials.save(args.user, pw)
    out({"ok": True, "user": args.user})
    return 0


def cmd_schedule(args) -> int:
    state = sync.load_json(sync.STATE, None)
    if not state:
        out({"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."})
        return 1
    evs = sync.load_json(sync.EVENTS, {}).get("items", [])
    out({"ok": True, **schedule.update(state, evs, sync.load_json(sync.CONTENT, {}), lambda d: sync.save_json(sync.SCHEDULE, d), int(time.time()))})
    return 0


def cmd_suggest(args) -> int:
    state = sync.load_json(sync.STATE, None)
    if not state:
        out({"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."})
        return 1
    evs = sync.load_json(sync.EVENTS, {}).get("items", [])
    dls = sync.load_json(sync.DEADLINES, {}).get("items", [])
    out({"ok": True, **suggest.update(state, evs, dls, sync.INDEX, lambda d: sync.save_json(sync.SUGGESTIONS, d), int(time.time()))})
    return 0


def cmd_selftest(args) -> int:
    """Ohne Netz und ohne Zugangsdaten: ist die Bruecke vollstaendig? (Fuer die mitgelieferte .exe von Kursbuch: fehlende Pakete zeigen sich hier.)"""
    checks: dict[str, dict] = {}

    def check(name, fn):
        try:
            checks[name] = {"ok": True, "info": fn()}
        except Exception as e:  # noqa: BLE001
            checks[name] = {"ok": False, "info": f"{type(e).__name__}: {e}"[:200]}

    def tresor():
        get = getattr(credentials.keyring, "get_keyring", None)
        if get is None:
            return "Testersatz"
        k = get()
        if k.__class__.__module__.endswith("fail"):
            raise RuntimeError("kein Tresor gefunden (keyring)")
        return type(k).__name__

    def zertifikate():
        import certifi
        import ssl
        return len(ssl.create_default_context(cafile=certifi.where()).get_ca_certs())

    def suche():
        db = sqlite3.connect(":memory:")
        db.execute("create virtual table t using fts5(a)")
        db.execute("insert into t values ('Klausur im Februar')")
        return sqlite3.sqlite_version if db.execute("select count(*) from t where t match 'klausur*'").fetchone()[0] == 1 else "keine Treffer"

    def leser():
        import docx  # noqa: F401
        import lxml.etree  # noqa: F401
        import pptx  # noqa: F401
        import pypdf  # noqa: F401
        return "pypdf, python-docx, python-pptx"

    def datenordner():
        d = sync.STATE.parent
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".selftest"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return str(d)

    def netz():
        """Eine einzige Anfrage an die oeffentliche Anmeldeseite (ohne Zugangsdaten): erreichbar, Zertifikat gueltig, Formular lesbar"""
        from .client import BASE, parse_logintoken
        with httpx.Client(timeout=20, follow_redirects=True, transport=_TRANSPORT) as c:
            r = c.get(f"{BASE}/login/index.php")
        r.raise_for_status()
        parse_logintoken(r.text)
        return "Anmeldeseite erreichbar"

    names = [("tresor", tresor), ("zertifikate", zertifikate), ("suche", suche), ("leser", leser), ("datenordner", datenordner)]
    if args.net:
        names.append(("netz", netz))
    for name, fn in names:
        check(name, fn)
    ok = all(c["ok"] for c in checks.values())
    out({"ok": ok, "python": sys.version.split()[0], "frozen": bool(getattr(sys, "frozen", False)), "home": str(sync.ROOT), "checks": checks})
    return 0 if ok else 1


def cmd_content(args) -> int:
    state = sync.load_json(sync.STATE, None)
    if not state:
        out({"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."})
        return 1
    if not sync.acquire_lock():
        out({"ok": False, "code": "locked", "error": "Ein Sync läuft gerade."})
        return 2
    try:
        cfg = sync.load_config()
        user = credentials.username()
        lw = sync.LearnWeb(Credentials(user, lambda: credentials.password(user)))
        res = content.update(lw, state, lambda: sync.load_json(sync.CONTENT, {}), lambda d: sync.save_json(sync.CONTENT, d),
                             cfg["pause_s"], int(time.time()), force=args.force)
        stamp = time.strftime("%Y-%m-%d %H:%M")
        for step in (lambda: index.update(state, Path(cfg["ziel"]), sync.INDEX, content=sync.load_json(sync.CONTENT, {})),):
            try:
                step()
            except Exception:  # noqa: BLE001  der Index darf den Abruf nie kippen
                pass
        out({"ok": True, "stamp": stamp, **res})
        return 0
    except credentials.NoCredentials as e:
        out({"ok": False, "code": "credentials", "error": str(e)})
        return 1
    except LoginError as e:
        out({"ok": False, "code": "login", "error": str(e)})
        return 1
    except LearnWebError as e:
        out({"ok": False, "code": "learnweb", "error": str(e)})
        return 1
    except httpx.HTTPError:
        out({"ok": False, "code": "network", "error": "LearnWeb ist nicht erreichbar."})
        return 1
    finally:
        sync.LOCK.unlink(missing_ok=True)


def cmd_logout(args) -> int:
    credentials.delete()
    out({"ok": True})
    return 0


# --------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stdin):  # Pipe zur App: UTF-8, nicht die Codepage der Konsole
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--password-stdin"]:  # Passwort nur dieser Sitzung: aus stdin, nicht aus dem Tresor
        argv.pop(0)
        credentials.session_password(sys.stdin.readline().rstrip("\r\n"))
    p = argparse.ArgumentParser(prog="learnweb.cli", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    s = sub.add_parser("sync")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_sync)
    i = sub.add_parser("index")
    i.add_argument("--rebuild", action="store_true")
    i.set_defaults(fn=cmd_index)
    sub.add_parser("events").set_defaults(fn=cmd_events)
    sub.add_parser("verzeichnis").set_defaults(fn=cmd_verzeichnis)
    f = sub.add_parser("fetch")
    f.add_argument("course", type=int)
    f.add_argument("cmid", type=int)
    f.add_argument("--all-sizes", action="store_true")
    f.set_defaults(fn=cmd_fetch)
    lg = sub.add_parser("login")
    lg.add_argument("user")
    lg.add_argument("--no-save", action="store_true", help="nur pruefen, nichts im Tresor ablegen")
    lg.set_defaults(fn=cmd_login)
    sub.add_parser("schedule").set_defaults(fn=cmd_schedule)
    sub.add_parser("suggest").set_defaults(fn=cmd_suggest)
    st = sub.add_parser("selftest")
    st.add_argument("--net", action="store_true", help="zusaetzlich die oeffentliche Anmeldeseite von LearnWeb abrufen (ohne Zugangsdaten)")
    st.set_defaults(fn=cmd_selftest)
    ct = sub.add_parser("content")
    ct.add_argument("--force", action="store_true")
    ct.set_defaults(fn=cmd_content)
    sub.add_parser("logout").set_defaults(fn=cmd_logout)
    c = sub.add_parser("config")
    c.add_argument("action", choices=["get", "set"])
    c.add_argument("key", nargs="?")
    c.add_argument("value", nargs="?")
    c.set_defaults(fn=cmd_config)
    args = p.parse_args(argv)
    if args.cmd == "config" and args.action == "set" and (args.key is None or args.value is None):
        p.error("config set braucht <schluessel> <wert>")
    try:
        return args.fn(args)
    except Exception as e:  # die App bekommt immer JSON, nie einen Traceback
        out({"ok": False, "error": f"{type(e).__name__}: {e}"[:300]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
