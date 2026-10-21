"""LearnWeb-Client (Uni Münster, Moodle) über die interne AJAX-API.

Die Token-API (moodle_mobile_app) ist auf LearnWeb gesperrt. Die Weboberfläche
selbst spricht aber mit lib/ajax/service.php – authentifiziert über Session-Cookie
plus sesskey. Genau das macht dieser Client: einloggen wie ein Browser, sesskey
merken, bei abgelaufener Session automatisch neu einloggen.

Bewusst NUR lesend. Keine Abgaben, keine Quizze, keine Forenbeiträge.
"""
from __future__ import annotations

import html as htmllib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse

import httpx

BASE = "https://www.uni-muenster.de/LearnWeb/learnweb2"
USER_AGENT = "learnweb-mcp/0.1 (private, read-only)"

# Fehlercodes, bei denen ein Re-Login hilft (Session abgelaufen / sesskey ungültig)
RELOGIN_CODES = {"invalidsesskey", "servicerequireslogin", "requireloginerror", "sessiontimedout"}


class LearnWebError(RuntimeError):
    pass


class LoginError(LearnWebError):
    pass


class FileTooLarge(LearnWebError):
    def __init__(self, url: str, size: int):
        super().__init__(f"Datei zu groß ({size / 1e6:.1f} MB)")
        self.url, self.size = url, size


# --------------------------------------------------------------------------- parsing helpers

_LOGINTOKEN_RE = re.compile(
    r'<input[^>]*name="logintoken"[^>]*value="([^"]+)"|<input[^>]*value="([^"]+)"[^>]*name="logintoken"'
)
_SESSKEY_RE = re.compile(r'"sesskey":"([^"]+)"')
_LOGINERR_RE = re.compile(
    r'id="loginerrormessage"[^>]*>(.*?)</|class="[^"]*loginerrors[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]+)', re.S
)
_PLUGINFILE_RE = re.compile(r'href="([^"]*?/pluginfile\.php/[^"]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


def parse_logintoken(page: str) -> str:
    # Nur das eigentliche Login-Formular betrachten (id="login"), nicht guestlogin
    start = page.find('id="login"')
    scope = page[start: page.find("</form>", start)] if start != -1 else page
    m = _LOGINTOKEN_RE.search(scope)
    if not m:
        raise LoginError("Kein logintoken auf der Login-Seite gefunden – hat sich das Formular geändert?")
    return m.group(1) or m.group(2)


def parse_sesskey(page: str) -> str | None:
    m = _SESSKEY_RE.search(page)
    return m.group(1) if m else None


def parse_login_error(page: str) -> str | None:
    m = _LOGINERR_RE.search(page)
    if not m:
        return None
    return htmllib.unescape(_TAG_RE.sub("", m.group(1) or m.group(2) or "")).strip() or None


def strip_html(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", htmllib.unescape(_TAG_RE.sub(" ", s))).strip()


def iso(ts: int | None) -> str | None:
    if not ts:
        return None
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def safe_filename(name: str, maxlen: int = 90) -> str:
    """Windows- und Obsidian-tauglich (keine # ^ [ ] in Linkzielen), gekürzt wegen 260-Zeichen-Pfadlimit."""
    name = re.sub(r'[<>:"/\\|?*#^\[\]\x00-\x1f]', "_", name).strip(" .")
    if len(name) > maxlen:
        stem, dot, ext = name.rpartition(".")
        if dot and 0 < len(ext) <= 5:
            name = stem[: maxlen - len(ext) - 1].rstrip(" ._") + "." + ext
        else:
            name = name[:maxlen].rstrip(" ._")
    # Windows-Gerätenamen (CON, NUL, COM1 …) öffneten beim Schreiben ein Gerät statt einer Datei
    if re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", name):
        name = "_" + name
    return name or "datei"


# --------------------------------------------------------------------------- client

@dataclass
class Credentials:
    username: str
    password_provider: Callable[[], str]  # erst bei Bedarf abfragen (keyring)


class LearnWeb:
    def __init__(self, creds: Credentials, base: str = BASE, transport: httpx.BaseTransport | None = None):
        self.base = base.rstrip("/")
        self.creds = creds
        self.sesskey: str | None = None
        self.http = httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(30.0),
            headers={"User-Agent": USER_AGENT},
            transport=transport,
        )

    # ------------------------------------------------------------------ session
    def login(self) -> None:
        self.http.cookies.clear()
        self.sesskey = None

        r = self.http.get(f"{self.base}/login/index.php")
        r.raise_for_status()
        token = parse_logintoken(r.text)

        r = self.http.post(
            f"{self.base}/login/index.php",
            data={
                "username": self.creds.username,
                "password": self.creds.password_provider(),
                "logintoken": token,
                "anchor": "",
            },
        )
        r.raise_for_status()
        if "/login/" in r.url.path:
            raise LoginError(parse_login_error(r.text) or "Login fehlgeschlagen (Kennung/Passwort?)")

        # Eingeloggt? /my/ darf nicht auf die Login-Seite umleiten.
        r = self.http.get(f"{self.base}/my/")
        r.raise_for_status()
        if "/login/" in r.url.path:
            raise LoginError("Login scheinbar erfolgreich, aber /my/ leitet zurück zum Login.")
        if "/admin/tool/policy/" in r.url.path:
            raise LoginError("LearnWeb will, dass du eine Richtlinie bestätigst – einmal im Browser einloggen und zustimmen.")
        sk = parse_sesskey(r.text)
        if not sk:
            raise LoginError("Eingeloggt, aber kein sesskey gefunden.")
        self.sesskey = sk

    def _ensure_session(self) -> None:
        if not self.sesskey:
            self.login()

    def ajax(self, method: str, args: dict[str, Any], _retry: bool = True) -> Any:
        self._ensure_session()
        r = self.http.post(
            f"{self.base}/lib/ajax/service.php",
            params={"sesskey": self.sesskey, "info": method},
            json=[{"index": 0, "methodname": method, "args": args}],
        )
        r.raise_for_status()
        try:
            payload = r.json()
        except json.JSONDecodeError as e:
            raise LearnWebError(f"{method}: keine JSON-Antwort ({r.status_code})") from e

        # Top-Level-Fehler (z. B. invalidsesskey) kommen als Objekt, nicht als Liste
        if isinstance(payload, dict):
            item = {"error": True, "exception": payload}
        else:
            item = payload[0]

        if item.get("error"):
            exc = item.get("exception") or {}
            code = exc.get("errorcode", "unknown")
            if code in RELOGIN_CODES and _retry:
                self.login()
                return self.ajax(method, args, _retry=False)
            raise LearnWebError(f"{method}: {code} – {exc.get('message', '')}".strip(" –"))
        return item.get("data")

    # ------------------------------------------------------------------ lesen
    def courses(self, classification: str = "inprogress") -> list[dict]:
        """classification: inprogress | future | past | all | favourites | hidden"""
        data = self.ajax(
            "core_course_get_enrolled_courses_by_timeline_classification",
            {"classification": classification, "limit": 0, "offset": 0, "sort": "fullname"},
        )
        return [
            {
                "id": c["id"],
                "name": strip_html(c.get("fullname")),
                "kurz": c.get("shortname"),
                "kategorie": c.get("coursecategory"),
                "favorit": c.get("isfavourite", False),
                "fortschritt": c.get("progress") if c.get("hasprogress") else None,
                "url": c.get("viewurl"),
            }
            for c in data.get("courses", [])
        ]

    def deadlines(self, days: int = 30, limit: int = 50) -> list[dict]:
        now = int(time.time())
        data = self.ajax(
            "core_calendar_get_action_events_by_timesort",
            {"timesortfrom": now - 86400, "timesortto": now + days * 86400, "limitnum": limit},
        )
        out = []
        for e in data.get("events", []):
            course = e.get("course") or {}
            out.append(
                {
                    "ts": e.get("timesort"),
                    "faellig": iso(e.get("timesort")),
                    "ueberfaellig": e.get("overdue", False),
                    "titel": strip_html(e.get("activityname") or e.get("name")),
                    "typ": e.get("modulename"),
                    "was": e.get("activitystr"),
                    "kurs": strip_html(course.get("fullname")),
                    "kurs_id": course.get("id"),
                    "url": e.get("url"),
                }
            )
        return out

    def course_contents(self, course_id: int) -> dict:
        raw = self.ajax("core_courseformat_get_state", {"courseid": course_id})
        state = json.loads(raw) if isinstance(raw, str) else raw
        # IDs kommen im State teils als String, teils als Zahl -> auf str normalisieren
        cms = {str(cm["id"]): cm for cm in state.get("cm", [])}
        sections_by_id = {str(s["id"]): s for s in state.get("section", [])}
        order = state.get("course", {}).get("sectionlist") or list(sections_by_id)

        sections = []
        for sid in order:
            s = sections_by_id.get(str(sid))
            if not s:
                continue
            items = []
            for cmid in s.get("cmlist", []):
                cm = cms.get(str(cmid))
                if not cm or not cm.get("uservisible", True):
                    continue
                items.append(
                    {
                        "cmid": int(cm["id"]),
                        "name": strip_html(cm.get("name")),
                        "typ": cm.get("module") or cm.get("modname"),
                        "url": cm.get("url"),
                    }
                )
            if items or s.get("hassummary"):
                sections.append({"abschnitt": strip_html(s.get("title")), "nummer": s.get("number"), "inhalte": items})
        return {"kurs_id": course_id, "abschnitte": sections}

    def notifications(self, limit: int = 10) -> list[dict]:
        data = self.ajax(
            "message_popup_get_popup_notifications",
            {"useridto": 0, "newestfirst": True, "limit": limit, "offset": 0},
        )
        return [
            {
                "zeit": iso(n.get("timecreated")),
                "gelesen": bool(n.get("read")),
                "betreff": strip_html(n.get("subject")),
                "text": strip_html(n.get("smallmessage") or n.get("fullmessage"))[:500],
                "url": n.get("contexturl"),
            }
            for n in data.get("notifications", [])
        ]

    # ------------------------------------------------------------------ dateien
    def _save(self, url: str, dest: Path, max_bytes: int | None = None) -> Path:
        with self.http.stream("GET", url) as r:
            r.raise_for_status()
            if "/login/" in r.url.path:
                raise LearnWebError("Download landet auf der Login-Seite – Session abgelaufen?")
            size = int(r.headers.get("content-length") or 0)
            if max_bytes and size > max_bytes:
                raise FileTooLarge(str(r.url), size)
            dest.mkdir(parents=True, exist_ok=True)
            name = None
            cd = r.headers.get("content-disposition", "")
            m = re.search(r"filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?", cd)
            if m:
                name = unquote(m.group(1) or m.group(2))
            if not name:
                name = unquote(urlparse(str(r.url)).path.rsplit("/", 1)[-1])
            target = dest / safe_filename(name)
            written = 0
            tmp = target.with_name(target.name + ".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes():
                    written += len(chunk)
                    if max_bytes and written > max_bytes:  # Server ohne content-length
                        f.close()
                        tmp.unlink(missing_ok=True)
                        raise FileTooLarge(str(r.url), written)
                    f.write(chunk)
            tmp.replace(target)
        return target

    def download(self, cmid: int, typ: str, dest: Path, max_bytes: int | None = None) -> list[Path]:
        """Lädt Dateien einer Aktivität herunter. typ: 'resource' oder 'folder'.
        Bei Ordnern landen übersprungene Riesendateien in self.last_skipped."""
        self._ensure_session()
        self.last_skipped = []
        if typ == "resource":
            r = self.http.get(f"{self.base}/mod/resource/view.php", params={"id": cmid, "redirect": 1})
            r.raise_for_status()
            if "/login/" in r.url.path:
                self.login()
                r = self.http.get(f"{self.base}/mod/resource/view.php", params={"id": cmid, "redirect": 1})
            if "pluginfile.php" in r.url.path:
                url = str(r.url)
            else:  # eingebettete Anzeige: ersten Datei-Link aus der Seite nehmen
                links = _PLUGINFILE_RE.findall(r.text)
                if not links:
                    raise LearnWebError(f"Keine Datei in Aktivität {cmid} gefunden.")
                url = htmllib.unescape(links[0])
            return [self._save(url, dest, max_bytes)]

        if typ == "folder":
            r = self.http.get(f"{self.base}/mod/folder/view.php", params={"id": cmid})
            r.raise_for_status()
            if "/login/" in r.url.path:
                self.login()
                r = self.http.get(f"{self.base}/mod/folder/view.php", params={"id": cmid})
            urls = list(dict.fromkeys(htmllib.unescape(u) for u in _PLUGINFILE_RE.findall(r.text)))
            urls = [u for u in urls if "/mod_folder/content/" in u] or urls
            if not urls:
                raise LearnWebError(f"Ordner {cmid} enthält keine Dateien.")
            saved = []
            self.last_skipped = []
            for u in urls:
                try:
                    saved.append(self._save(u, dest, max_bytes))
                except FileTooLarge as e:  # einzelne Riesendatei soll nicht den ganzen Ordner kippen
                    self.last_skipped.append(e)
            if not saved and self.last_skipped:
                raise self.last_skipped[0]
            return saved

        raise LearnWebError(f"Download nur für 'resource' und 'folder', nicht für '{typ}'.")
