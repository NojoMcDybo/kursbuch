"""Inhalte ohne Datei: Ankuendigungen aus den Nachrichtenforen, Aufgaben (Beschreibung, Abgabestatus) und Dozenten (Kontakt, Quelle).

    uv run python -m learnweb.cli content [--force]     # nur diesen Teil auffrischen (sonst macht es der Sync mit)

Ergebnis: data/content.json, je Kurs {news, assignments, teachers, contacts}. Nur lesend gegenueber LearnWeb, mit der Pause des Syncs
zwischen den Anfragen und sparsam:
- Ankuendigungen: die Forumsseite je Nachrichtenforum (eine Anfrage), Beitraege nur fuer neue Themen (mod_forum_get_discussion_posts).
- Aufgaben: die Aufgabenseite je Aufgabe (Beschreibung, Abgabe- und Bewertungsstatus); die Faelligkeit steht in deadlines.json.
- Dozenten: Teilnehmerliste gefiltert nach Rolle (Lehrende, Tutoren) und je Person das Profil (E-Mail, weitere Angaben); nur alle 14
  Tage neu. Es wird nie eine Studierende oder ein Studierender gespeichert.
- Weitere Kontakte: E-Mail-Adressen, die in Texten des Kurses stehen (Labels, Ankuendigungen), mit Fundstelle.
"""
from __future__ import annotations

import html
import re
import time
import urllib.parse
from html.parser import HTMLParser
from typing import Callable

import httpx

from .client import LearnWeb, LearnWebError

MAX_TEXT = 8000
MAX_NEWS = 30
NEW_DISCUSSIONS = 8
TEACHER_DAYS = 14
# Foren, in denen Dozenten ankuendigen (nicht die Frage-und-Antwort-Foren der Studierenden)
NEWS_FORUM = re.compile(r"nachricht|ank[uü]ndig|news|announce|update|willkommen|welcome|mitteilung|hinweis", re.I)
# Rollen in LearnWeb: 3 Lehrende/r, 9 Tutor mit Bearbeitungsrechten, 4 Tutor zur Betreuung von Uebungen
TEACHER_ROLES = (3, 9, 4)
ROLE_WORDS = re.compile(r"lehrende|tutor|dozent|teacher", re.I)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")


# --------------------------------------------------------------------------- HTML -> Text

class _Text(HTMLParser):
    BIG = {"p", "div", "ul", "ol", "table", "blockquote", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "pre"}
    SMALL = {"br", "li", "tr", "hr"}
    SKIP = {"script", "style", "head", "title", "noscript", "template"}

    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base, self.out, self.skip = base, [], 0
        self.links: list[dict] = []
        self._a: tuple[str, list[str]] | None = None

    def _nl(self, n: int) -> None:
        self.out.append("\n" * n)

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BIG:
            self._nl(2)
        elif tag in self.SMALL:
            self._nl(1)
        if tag == "li" and not self.skip:
            self.out.append("- ")
        if tag == "a" and not self.skip:
            href = dict(attrs).get("href") or ""
            self._a = (href, [])

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BIG:
            self._nl(2)
        if tag == "a" and self._a:
            href, parts = self._a
            self._a = None
            url = urllib.parse.urljoin(self.base, href.strip()) if href.strip() else ""
            if url.lower().startswith(("http://", "https://", "mailto:")) and not any(link["url"] == url for link in self.links) and len(self.links) < 20:
                text = " ".join("".join(parts).split()) or url
                self.links.append({"text": text[:120], "url": url[:500]})

    def handle_data(self, data):
        if self.skip:
            return
        self.out.append(data)
        if self._a:
            self._a[1].append(data)


def html_text(src: str | None, base: str = "") -> tuple[str, list[dict]]:
    """HTML -> (Text mit Absaetzen und „- “ vor Listenpunkten, Verweise). Nie eine Ausnahme, nie mehr als MAX_TEXT Zeichen."""
    if not src:
        return "", []
    p = _Text(base)
    try:
        p.feed(src)
        p.close()
    except Exception:  # kaputtes HTML: nehmen, was bis dahin gelesen wurde  # noqa: BLE001
        pass
    text = "".join(p.out).replace("\xa0", " ").replace("\r", "")
    lines = [" ".join(line.split()) for line in text.split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT].rsplit("\n", 1)[0].rstrip() + " …"
    return text, p.links


# --------------------------------------------------------------------------- Seiten lesen

def forum_discussions(page: str) -> list[dict]:
    """Themen einer Forumsseite, neueste zuerst wie auf der Seite: [{id, title}] (Titel aus title="…" oder dem Verweistext)"""
    out, seen = [], set()
    for m in re.finditer(r"<a\b([^>]*)>(.*?)</a>", page, re.S):
        attrs, inner = m.group(1), m.group(2)
        href = re.search(r'href="[^"]*discuss\.php\?d=(\d+)', attrs)
        if not href or int(href.group(1)) in seen:
            continue
        d = int(href.group(1))
        seen.add(d)
        title = re.search(r'title="([^"]*)"', attrs)
        out.append({"id": d, "title": html.unescape(title.group(1)).strip() if title else html_text(inner)[0]})
    return out


def news_forums(entry: dict) -> list[tuple[int, str]]:
    """Nachrichtenforen eines Kurses aus dem State: [(cmid, Name)]"""
    return [(int(k), cm["name"]) for k, cm in entry.get("cms", {}).items() if cm.get("typ") == "forum" and NEWS_FORUM.search(cm.get("name", ""))]


def parse_posts(data: dict, forum_cmid: int, forum_name: str, base: str) -> list[dict]:
    """Antwort von mod_forum_get_discussion_posts -> Eintraege (Beitrag fuer Beitrag, aelteste zuerst)"""
    out = []
    for p in (data or {}).get("posts", [])[:6]:
        if p.get("isdeleted") or p.get("isprivatereply"):
            continue
        text, links = html_text(p.get("message"), base)
        author = p.get("author") or {}
        out.append({
            "id": p.get("id"), "discussion": p.get("discussionid"), "forum": forum_cmid, "forum_name": forum_name,
            "title": html.unescape((p.get("subject") or "").strip())[:200], "author": author.get("fullname") or "", "author_id": author.get("id"),
            "ts": p.get("timecreated"), "text": text, "links": links,
            "files": [{"name": a.get("filename"), "url": a.get("fileurl")} for a in (p.get("attachments") or []) if a.get("fileurl")][:10],
            "url": (p.get("urls") or {}).get("view"),
        })
    return out


def _cells(page: str) -> list[tuple[str, str]]:
    """Beschriftung/Wert-Paare der Statustabelle einer Aufgabenseite (th/td)"""
    out = []
    for th, td in re.findall(r"<th[^>]*class=\"[^\"]*cell[^\"]*\"[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>", page, re.S):
        k, v = html_text(th)[0], html_text(td)[0]
        if k:
            out.append((k, v))
    return out


def parse_assign(page: str, base: str = "") -> dict:
    """Aufgabenseite -> {intro, links, opens, due, status, grading, remaining}; Fehlendes bleibt leer"""
    intro = re.search(r'id="intro"[^>]*>(.*?)</div>\s*</div>', page, re.S)
    text, links = html_text(intro.group(1) if intro else "", base)
    dates = re.search(r'data-region="activity-dates"(.*?)</div>\s*</div>', page, re.S)
    when = html_text(dates.group(1))[0] if dates else ""
    found = {m.group(1).lower(): m.group(2).strip() for m in re.finditer(r"(Geöffnet|Opened|Fällig|Due)\s*:\s*(.+?)(?=\s+(?:Geöffnet|Opened|Fällig|Due)\s*:|$)", " ".join(when.split()), re.I | re.S)}
    cells = dict(_cells(page))
    return {
        "intro": text, "links": links,
        "opens": found.get("geöffnet") or found.get("opened"), "due": found.get("fällig") or found.get("due") or cells.get("Abgabetermin"),
        "status": cells.get("Abgabestatus", ""), "grading": cells.get("Bewertungsstatus", ""), "remaining": cells.get("Verbleibende Zeit", ""),
    }


def parse_participants(page: str, base: str = "") -> list[dict]:
    """Teilnehmerliste -> nur Personen mit Lehr- oder Tutorrolle: [{id, name, role}] (Studierende werden nie uebernommen)"""
    out = []
    for row in re.findall(r'<tr[^>]*id="user-index-participants-[^"]*"[^>]*>(.*?)</tr>', page, re.S):
        who = re.search(r'<th[^>]*class="[^"]*c1[^"]*"[^>]*>(.*?)</th>', row, re.S)
        role = re.search(r'<td[^>]*class="[^"]*c2[^"]*"[^>]*>(.*?)</td>', row, re.S)
        uid = re.search(r"user/view\.php\?id=(\d+)", who.group(1)) if who else None
        r = html_text(role.group(1))[0] if role else ""
        if who and uid and ROLE_WORDS.search(r):
            out.append({"id": int(uid.group(1)), "name": html_text(who.group(1))[0], "role": r})
    return out


def parse_profile(page: str) -> dict:
    """Profilseite -> {email, fields}; die E-Mail steht in LearnWeb gegen Suchmaschinen verschluesselt (Zeichenverweise)"""
    fields, email = {}, None
    for dt, dd in re.findall(r"<dt[^>]*>(.*?)</dt>\s*<dd[^>]*>(.*?)</dd>", page, re.S):
        k, (v, _) = html_text(dt)[0], html_text(dd)
        if not k or not v:
            continue
        if k.lower().replace("-", "").startswith("email"):  # „E-Mail-Adresse“ / „Email address“ (englisches Profil)
            m = EMAIL.search(v) or EMAIL.search(urllib.parse.unquote(html.unescape(re.sub(r"<[^>]+>", " ", dd))))
            email = m.group(0) if m else None
        elif k.lower() not in ("zeitzone", "timezone", "rollen", "roles") and len(fields) < 10:
            fields[k[:60]] = v[:200]
    return {"email": email, "fields": fields}


def emails_in(text: str) -> list[str]:
    return list(dict.fromkeys(m.group(0).lower() for m in EMAIL.finditer(text or "")))


# --------------------------------------------------------------------------- sammeln

def _page(lw: LearnWeb, path: str, pause: float, **params) -> str:
    """Seite holen (mit Sitzung; abgelaufen -> einmal neu anmelden). Eine Umleitung auf die Anmeldeseite ist ein Fehler, kein leerer Treffer."""
    time.sleep(pause)
    lw._ensure_session()
    for attempt in (0, 1):
        r = lw.http.get(f"{lw.base}/{path}", params=params)
        r.raise_for_status()
        if "/login/" not in r.url.path:
            return r.text
        if attempt == 0:
            lw.login()
    raise LearnWebError("LearnWeb verlangt die Anmeldung (Sitzung abgelaufen?)")


def collect_news(lw: LearnWeb, entry: dict, prev: list[dict], pause: float) -> tuple[list[dict], int]:
    known = {p["discussion"] for p in prev}
    items = list(prev)
    errors = 0
    for cmid, name in news_forums(entry):
        try:
            found = forum_discussions(_page(lw, "mod/forum/view.php", pause, id=cmid))[:NEW_DISCUSSIONS]
            for d in found:
                if d["id"] in known:
                    continue
                time.sleep(pause)
                data = lw.ajax("mod_forum_get_discussion_posts", {"discussionid": d["id"], "sortby": "created", "sortdirection": "ASC"})
                items += parse_posts(data, cmid, name, lw.base + "/")
                known.add(d["id"])
        except (LearnWebError, httpx.HTTPError):
            errors += 1
    items.sort(key=lambda p: p.get("ts") or 0, reverse=True)
    return items[:MAX_NEWS], errors


def collect_assignments(lw: LearnWeb, entry: dict, pause: float) -> tuple[list[dict], int]:
    out, errors = [], 0
    for k, cm in entry.get("cms", {}).items():
        if cm.get("typ") != "assign":
            continue
        try:
            a = parse_assign(_page(lw, "mod/assign/view.php", pause, id=int(k)), lw.base + "/")
            out.append({"cmid": int(k), "name": cm["name"], "url": cm.get("url"), **a})
        except (LearnWebError, httpx.HTTPError):
            errors += 1
    return out, errors


def collect_teachers(lw: LearnWeb, course_id: int, pause: float, now: int) -> tuple[list[dict], int]:
    people: dict[int, dict] = {}
    errors = 0
    for role in TEACHER_ROLES:
        try:
            for p in parse_participants(_page(lw, "user/index.php", pause, id=course_id, roleid=role), lw.base + "/"):
                people.setdefault(p["id"], p)
        except (LearnWebError, httpx.HTTPError):
            errors += 1
    out = []
    for p in people.values():
        url = f"{lw.base}/user/view.php?id={p['id']}&course={course_id}"
        try:
            prof = parse_profile(_page(lw, "user/view.php", pause, id=p["id"], course=course_id))
        except (LearnWebError, httpx.HTTPError):
            errors += 1
            prof = {"email": None, "fields": {}}
        out.append({**p, **prof, "profile": url, "source": "LearnWeb: Teilnehmerliste und Profil", "checked": now})
    return out, errors


def found_contacts(entry: dict, news: list[dict], assignments: list[dict], teachers: list[dict]) -> list[dict]:
    """E-Mail-Adressen in Texten des Kurses (Labels, Ankuendigungen, Aufgaben) mit Fundstelle; die der Dozenten oben nicht doppelt"""
    have = {t["email"].lower() for t in teachers if t.get("email")}
    out: dict[str, str] = {}

    def add(text: str, where: str) -> None:
        for e in emails_in(text):
            if e not in have:
                out.setdefault(e, where)

    for cm in entry.get("cms", {}).values():
        if cm.get("typ") == "label":
            add(cm.get("name", ""), f"Text im Kurs ({cm.get('section', '')})".replace(" ()", ""))
    for n in news:
        add(n.get("text", ""), f"Ankündigung „{n.get('title', '')[:60]}“")
    for a in assignments:
        add(a.get("intro", ""), f"Aufgabe „{a.get('name', '')[:60]}“")
    return [{"email": e, "where": w} for e, w in out.items()]


def collect_course(lw: LearnWeb, entry: dict, prev: dict, pause: float, now: int, force: bool = False) -> tuple[dict, int]:
    news, e1 = collect_news(lw, entry, prev.get("news", []), pause)
    assignments, e2 = collect_assignments(lw, entry, pause)
    old = prev.get("teachers")
    fresh = old is not None and not force and prev.get("teachers_at", 0) > now - TEACHER_DAYS * 86400
    if fresh:
        teachers, e3, at = old, 0, prev["teachers_at"]
    else:
        teachers, e3 = collect_teachers(lw, entry["id"], pause, now)
        at = now
        if e3 and old:  # Abruf unvollstaendig: lieber den alten Stand behalten
            teachers, at = old, prev.get("teachers_at", 0)
    return {"news": news, "assignments": assignments, "teachers": teachers, "teachers_at": at,
            "contacts": found_contacts(entry, news, assignments, teachers)}, e1 + e2 + e3


def update(lw: LearnWeb, state: dict, load: Callable[[], dict], save: Callable[[dict], None], pause: float, now: int, force: bool = False) -> dict:
    """Alle Kurse des State auffrischen; nach jedem Kurs sichern. Rueckgabe: Kennzahlen fuers Protokoll."""
    data = load() or {}
    courses = data.get("courses", {})
    errors = 0
    for cid, entry in state.get("courses", {}).items():
        c, e = collect_course(lw, entry, courses.get(cid, {}), pause, now, force)
        courses[cid] = c
        errors += e
        save({"updated": now, "courses": courses})
    courses = {k: v for k, v in courses.items() if k in state.get("courses", {})}  # Kurse, die nicht mehr im State stehen, fliegen raus
    save({"updated": now, "courses": courses})
    return {"courses": len(courses), "news": sum(len(c["news"]) for c in courses.values()),
            "assignments": sum(len(c["assignments"]) for c in courses.values()),
            "teachers": sum(len(c["teachers"]) for c in courses.values()), "errors": errors}
