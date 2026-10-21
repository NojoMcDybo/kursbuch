"""Sofort-Download einer Aktivitaet (Datei oder Ordner) auf Knopfdruck aus der App, ohne ganzen Sync.

    uv run python -m learnweb.cli fetch <kurs-id> <cmid> [--all-sizes]

Laedt nur diese eine Aktivitaet an die Stelle, an die der Sync sie auch legen wuerde (<Kurs>/<NN Abschnitt>/...), traegt sie im
State ein und zieht Kursnotiz, Suchindex und Verzeichnis nach. Ohne --all-sizes gilt die Groessengrenze des Syncs
(`max_mb`); mit --all-sizes laedt es auch Dateien, die beim Sync als zu gross uebersprungen wurden (ausdruecklicher Wunsch).
Wie der Sync nur lesend gegenueber LearnWeb, eine Anfrage-Welle, unter derselben Sperre (kein Sync gleichzeitig).
"""
from __future__ import annotations

import time
from pathlib import Path

import httpx

from . import credentials, index, sync, verzeichnis
from .client import Credentials, FileTooLarge, LearnWebError, LoginError


def fetch(course_id: int, cmid: int, all_sizes: bool = False) -> tuple[int, dict]:
    """(Exitcode, Ergebnis): 0 ok, 1 Fehler, 2 ein Sync laeuft."""
    state = sync.load_json(sync.STATE, None)
    if not state:
        return 1, {"ok": False, "error": "Noch kein Sync gelaufen (data/sync_state.json fehlt)."}
    course = state.get("courses", {}).get(str(course_id))
    cm = course["cms"].get(str(cmid)) if course else None
    if not cm:
        return 1, {"ok": False, "error": "Aktivität nicht gefunden."}
    if cm.get("typ") not in sync.FILE_TYPES:
        return 1, {"ok": False, "error": "Nur Dateien und Ordner lassen sich laden."}
    if not sync.acquire_lock():
        return 2, {"ok": False, "code": "locked", "error": "Ein Sync läuft gerade."}
    try:
        cfg = sync.load_config()
        ziel = Path(cfg["ziel"])
        user = credentials.username()
        lw = sync.LearnWeb(Credentials(user, lambda: credentials.password(user)))
        dest = ziel / course["dir"] / cm["section"]
        if cm["typ"] == "folder":
            dest = dest / sync.clean(cm["name"], 40)
        paths = lw.download(cmid, cm["typ"], dest, None if all_sizes else int(cfg["max_mb"] * 1e6))
        cm["files"] = sorted({p.relative_to(ziel).as_posix() for p in paths})
        cm["skipped"] = [] if all_sizes else [{"mb": round(e.size / 1e6, 1)} for e in getattr(lw, "last_skipped", [])]
        cm.pop("error", None)
        sync.save_json(sync.STATE, state)
        # Nachziehen: Kursnotiz (Link auf die neue Datei), Suchindex, Verzeichnis. Das kippt den Download nie.
        stamp = time.strftime("%Y-%m-%d %H:%M")
        for step in (lambda: sync.write_text(ziel / course["dir"] / f"{course['dir']}.md", sync.course_note(course, stamp)),
                     lambda: index.update(state, ziel, sync.INDEX),
                     lambda: verzeichnis.update(state, ziel, sync.INDEX, sync.write_text, stamp)):
            try:
                step()
            except Exception:  # noqa: BLE001
                pass
        return 0, {"ok": True, "files": cm["files"], "skipped": cm["skipped"]}
    except FileTooLarge as e:
        return 1, {"ok": False, "code": "too_large", "error": f"Die Datei ist {e.size / 1e6:.0f} MB groß (Grenze {cfg['max_mb']} MB)."}
    except LoginError as e:
        return 1, {"ok": False, "code": "login", "error": str(e)}
    except LearnWebError as e:
        return 1, {"ok": False, "code": "learnweb", "error": str(e)}
    except httpx.HTTPError:
        return 1, {"ok": False, "code": "network", "error": "LearnWeb ist nicht erreichbar."}
    except credentials.NoCredentials as e:
        return 1, {"ok": False, "code": "credentials", "error": str(e)}
    finally:
        sync.LOCK.unlink(missing_ok=True)
