"""Vorschlaege fuer Termine und Fristen aus den Texten der Kurse (Phase 5), nur lokal und ohne LearnWeb-Zugriff.

Quelle ist der Suchindex (`data/index.db`: Seiten von PDF, DOCX, PPTX, dazu Ankuendigungen und Aufgabentexte). Ein Treffer ist ein Datum
im Text, das

* ein Stichwort in seiner Naehe hat, und zwar naeher als jedes andere Datum (Klausur/Pruefung/exam, Abgabe/deadline/bis/until/Anmeldung,
  Symposium/Workshop/Beginn),
* nicht zu Rauschen gehoert (Download-Stempel, Literatur mit „Accessed …“, Lizenzvermerk, Abschnittsnummern wie „Quote 4.5.“) und
* im Zeitfenster [heute − 7 Tage, heute + 300 Tage] liegt. Ohne Jahresangabe zaehlt das Jahr, in dem das Datum zum Semester des Kurses
  (aus dem Kursnamen) oder zu den Jahreszahlen der Seite passt; sonst das naechste passende.

Gemessen (Stichproben von 140 und 120 Textstellen, von Hand beschriftet, docs/phase5-laya-messung.md): Die Stichwortregeln ordnen Pruefung,
Abgabe und Termin zu etwa 80 % richtig ein, Zeitfenster und Semester entfernen das Rauschen. Laya (Zero-Shot, englisches Modell) war nicht
besser und mit 2–6 s je Textstelle langsam; es bleibt ein spaeterer Helfer fuer die Sicherheit. Jeder Vorschlag kommt mit Quelle und
Sicherheit und wird erst nach Bestaetigung ein Termin (Kursbuch: Zeitstrahl).

Ausgabe: `data/suggestions.json` mit `items` (id, course_id, kind frist | pruefung | termin, ts, all_day, day, title, short, source,
confidence hoch | mittel). Stabile IDs (Hash aus Kurs, Tag, Art, Textanfang), damit „uebernommen“ und „verworfen“ bleiben.
"""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
import re
import sqlite3
import time
from pathlib import Path

MONTH = {
    "januar": 1, "jan": 1, "january": 1, "februar": 2, "feb": 2, "february": 2, "märz": 3, "maerz": 3, "mär": 3, "mar": 3, "march": 3,
    "april": 4, "apr": 4, "mai": 5, "may": 5, "juni": 6, "jun": 6, "june": 6, "juli": 7, "jul": 7, "july": 7, "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9, "oktober": 10, "okt": 10, "oct": 10, "october": 10, "november": 11, "nov": 11,
    "dezember": 12, "dez": 12, "dec": 12, "december": 12,
}
_MON = "|".join(sorted(MONTH, key=len, reverse=True))
DATE = re.compile(
    r"(?<![\d.])(?P<d1>[0-3]?\d)\.\s?(?P<m1>[01]?\d)\.(?:\s?(?P<y1>20\d\d)(?!\d)|(?P<y1s>\d\d)(?![\d.]))?(?!\d)"
    rf"|(?<![\d.])(?P<d2>[0-3]?\d)(?:st|nd|rd|th)?\.?\s+(?:of\s+)?(?P<m2>{_MON})\b\.?(?:,?\s+(?P<y2>20\d\d)(?!\d))?"
    rf"|\b(?P<m3>{_MON})\.?\s+(?P<d3>[0-3]?\d)(?:st|nd|rd|th)?\b(?!\d)(?:,?\s+(?P<y3>20\d\d)(?!\d))?"
    r"|(?<!\d)(?P<y4>20\d\d)-(?P<m4>[01]\d)-(?P<d4>[0-3]\d)(?!\d)",
    re.I,
)
TIME = re.compile(r"(?<!\d)([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*(?:Uhr|h)\b|(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)", re.I)

# Rauschen rund um das Datum: Download-Stempel, Literatur, Lizenz
NOISE = re.compile(
    r"This content downloaded|downloaded from|Accessed|Lizenziert|Copyright|©|ISBN|Available online|Received\b|\bWeb\.|\bpp\.|"
    r"https?://|doi\.org|Layout:|\bPage:",
    re.I,
)
# Abschnittsnummern („Quote 4.5.“, „Kapitel 3.1.“) sind keine Daten
HEADING = re.compile(r"(?:Figure|Fig\.|Quotes?|Concepts?|Table|Tabelle|Abb\.|Kapitel|chapter|Sect\.|Section|Abschnitt)\s*$", re.I)
EXAM = re.compile(r"klausur|prüfung|pruefung|\bexam(?:ination)?s?\b|\bquiz|kolloquium|colloquium|\bMC[- ]", re.I)
DEADLINE = re.compile(
    r"deadline|\bdue\b|\buntil\b|\bbis\b|spätestens|abgabe|einreich|submi(?:t|ssion)|upload|hochlad|anmeld|"
    r"regist|\bfrist\b|wähle|ausfüll|ausfuell|fill in",
    re.I,
)
EVENT = re.compile(
    r"symposium|workshop|exkursion|excursion|tagung|konferenz|conference|beginnt|startet|\bstarts?\b|begins|kick-?off|eröffnung|"
    r"präsentation|presentation|blockseminar|\bmeeting\b|we will meet",
    re.I,
)
SHORT = {"pruefung": "Prüfung", "frist": "Frist", "termin": "Termin"}
BEFORE, AFTER = 110, 130  # Zeichen um den Treffer (Ausschnitt)
NEAR = 70  # Stichwort darf so weit vom Datum stehen
SEM = re.compile(r"\b(SoSe|WiSe)\s*(20\d\d)(?:\s*[/-]\s*(\d\d(?:\d\d)?))?", re.I)


def semester_span(name: str) -> tuple[dt.date, dt.date] | None:
    """Zeitraum des Semesters aus dem Kursnamen („… SoSe 2026“, „… WiSe 2026/27“): April–September bzw. Oktober–Maerz, je mit Spielraum"""
    m = SEM.search(name or "")
    if not m:
        return None
    y = int(m.group(2))
    if m.group(1).lower() == "sose":
        return dt.date(y, 3, 15), dt.date(y, 10, 15)
    return dt.date(y, 9, 15), dt.date(y + 1, 4, 15)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _parts(m: re.Match) -> tuple[int, int, int | None]:
    g = m.groupdict()
    for d, mo, y in (("d1", "m1", "y1"), ("d2", "m2", "y2"), ("d3", "m3", "y3"), ("d4", "m4", "y4")):
        if g[d]:
            month = int(g[mo]) if g[mo].isdigit() else MONTH[g[mo].lower()]
            year = int(g[y] or g.get(y + "s") or 0) or None
            return int(g[d]), month, (2000 + year if year is not None and year < 100 else year)
    raise ValueError("kein Datum")


def in_window(day: dt.date, today: dt.date) -> bool:
    return today - dt.timedelta(days=1) <= day <= today + dt.timedelta(days=300)


def _resolve(d: int, mo: int, y: int | None, today: dt.date, span, page_years: list[int]) -> dt.date | None:
    """Das Datum mit Jahr: angegeben, sonst aus Semester des Kurses, Jahreszahlen der Seite oder als naechstes passendes"""
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None

    def mk(year: int) -> dt.date | None:
        try:
            return dt.date(year, mo, d)
        except ValueError:
            return None

    if y is not None:
        return mk(y)
    if span:
        cands = [x for x in (mk(span[0].year), mk(span[1].year)) if x and span[0] <= x <= span[1]]
        return cands[0] if cands else None
    if page_years:
        cands = [x for x in (mk(py) for py in dict.fromkeys(page_years)) if x and in_window(x, today)]
        return min(cands, key=lambda x: abs((x - today).days)) if cands else None
    for year in (today.year, today.year + 1):
        x = mk(year)
        if x and x >= today - dt.timedelta(days=14):
            return x
    return None


def _short(flat: str, m: re.Match, kind: str) -> str:
    """Kurzer Titel: die Woerter vor dem Datum samt Datum („Abgabe des Essays bis 27.10.2026“); sonst die Art"""
    lo = max(0, m.start() - 34)
    left = flat[lo:m.end()]
    if lo > 0:
        left = left.split(" ", 1)[-1]  # das angeschnittene erste Wort faellt weg
    left = left.strip(" .:;,-–•|()\"„“")
    return left[-46:].strip() or SHORT[kind]


def _time_after(text: str, end: int) -> tuple[int, int] | None:
    m = TIME.search(text[end:end + 28])
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2) or 0)) if m.group(1) is not None else (int(m.group(3)), int(m.group(4)))


RANGE = re.compile(r"^\s*(?:–|-|—|bis(?: zum)?|to|until|und|and)\s*$", re.I)


def _kind(flat: str, mi: int, ms: list[re.Match]) -> tuple[str, str] | None:
    """(Art, Sicherheit) fuer das Datum Nr. mi unter allen Daten ms oder None. Ein Stichwort gehoert zum naechsten Datum; bei einem
    Zeitraum („26 Oct – 15 Dec“) zu beiden, und von einer Frist oder Pruefung zaehlt dann nur das Ende."""
    centers = [(m.start() + m.end()) // 2 for m in ms]
    pair = {}
    for j in range(len(ms) - 1):
        if ms[j + 1].start() - ms[j].end() <= 12 and RANGE.match(flat[ms[j].end():ms[j + 1].start()]):
            pair[j], pair[j + 1] = j + 1, j
    c = centers[mi]
    lo, hi = max(0, c - NEAR - 12), c + NEAR + 12
    for kind, rx in (("pruefung", EXAM), ("frist", DEADLINE), ("termin", EVENT)):
        for k in rx.finditer(flat, lo, hi):
            kc = (k.start() + k.end()) // 2
            nearest = min(range(len(centers)), key=lambda j: abs(centers[j] - kc))
            if nearest != mi and pair.get(nearest) != mi:
                continue
            if abs(kc - c) > NEAR and pair.get(mi) is None:
                continue
            if kind != "termin" and pair.get(mi) is not None and pair[mi] > mi:
                return None  # Anfang eines Zeitraums: die Frist ist das Ende
            return kind, "hoch" if abs(kc - c) <= 30 else "mittel"
    return None


def extract(text: str, today: dt.date, *, source: str = "", course_id: int | None = None, span=None) -> list[dict]:
    """Alle Vorschlaege aus einem Text"""
    flat = _norm(text)
    ms = list(DATE.finditer(flat))
    if not ms:
        return []
    page_years = [y for m in ms if (y := _parts(m)[2]) is not None and 2000 < y < 2100]
    page_years += [int(y) for y in re.findall(r"(?<!\d)(20[12]\d)(?!\d)", flat)]
    out, seen = [], set()
    for i, m in enumerate(ms):
        d, mo, y = _parts(m)
        day = _resolve(d, mo, y, today, span, page_years)
        if day is None or not in_window(day, today):
            continue
        if NOISE.search(flat[max(0, m.start() - 60):m.end() + 40]) or HEADING.search(flat[max(0, m.start() - 14):m.start()]):
            continue
        found = _kind(flat, i, ms)
        if found is None:
            continue
        kind, conf = found
        if y is None:
            conf = "mittel"  # das Jahr ist erschlossen
        hm = _time_after(flat, m.end())
        ts = int(time.mktime((day.year, day.month, day.day, hm[0] if hm else 0, hm[1] if hm else 0, 0, 0, 0, -1)))
        snip = flat[max(0, m.start() - BEFORE):m.end() + AFTER].strip()
        if (day, kind) in seen:
            continue
        seen.add((day, kind))
        sid = hashlib.sha1(f"{course_id}|{day.isoformat()}|{kind}|{re.sub(r'[^a-z]', '', snip.lower())[:60]}".encode()).hexdigest()[:12]
        out.append({
            "id": f"s-{sid}", "course_id": course_id, "kind": kind, "ts": ts, "all_day": hm is None, "day": day.isoformat(),
            "title": snip[:160], "short": _short(flat, m, kind), "source": source, "confidence": conf,
        })
    return out


def _sources(db: sqlite3.Connection):
    q = ("select e.course_id, e.kind, e.title, e.page, f.body from entries e join fts f on f.rowid = e.id "
         "where e.kind in ('pdf', 'pptx', 'docx', 'news', 'assignment')")
    for course_id, kind, title, page, body in db.execute(q):
        if kind == "news":
            src = f"Ankündigung · {title}"[:90]
        elif kind == "assignment":
            src = f"Aufgabe · {title}"[:90]
        else:
            src = f"{title} · {'Folie' if kind == 'pptx' else 'Seite'} {page}" if page else str(title)
        yield course_id, src, body or ""


def _known(events: list[dict], deadlines: list[dict]) -> set[tuple]:
    """(Kurs, Tag, Art) bekannter Termine: events.json und die Fristen von LearnWeb (deadlines.json)"""
    out = {(e.get("course_id"), e.get("day"), e.get("kind")) for e in events}
    out |= {(d.get("kurs_id"), str(d.get("faellig", ""))[:10], "frist") for d in deadlines if d.get("faellig")}
    return out


def _is_known(known: set[tuple], course_id, day: str, kind: str) -> bool:
    if (course_id, day, kind) in known:
        return True
    # eine Abgabe und eine Pruefung am selben Tag desselben Kurses gelten als dasselbe Ereignis
    return kind in ("frist", "pruefung") and any((course_id, day, k) in known for k in ("frist", "pruefung"))


def build(index_db: Path, events: list[dict], deadlines: list[dict], today: dt.date, names: dict[int, str] | None = None) -> list[dict]:
    """Vorschlaege fuer alle Kurse; schon bekannte Fristen und Pruefungen fallen weg"""
    if not index_db.exists():
        return []
    known = _known(events, deadlines)
    spans = {cid: semester_span(n) for cid, n in (names or {}).items()}
    db = sqlite3.connect(f"file:{index_db.as_posix()}?mode=ro", uri=True)
    try:
        found: dict[tuple, dict] = {}
        for course_id, src, body in _sources(db):
            for s in extract(body, today, source=src, course_id=course_id, span=spans.get(course_id)):
                if _is_known(known, course_id, s["day"], s["kind"]):
                    continue
                k = (course_id, s["day"], s["kind"])
                if k not in found or (s["confidence"] == "hoch" and found[k]["confidence"] != "hoch"):
                    found[k] = s
    finally:
        db.close()
    return sorted(found.values(), key=lambda s: (s["ts"], s["course_id"] or 0, s["id"]))


def update(state: dict, events: list[dict], deadlines: list[dict], index_db: Path, save, now: int | None = None, today: dt.date | None = None) -> dict:
    """data/suggestions.json schreiben; Rueckgabe fuer die JSON-Zeile des Syncs"""
    today = today or dt.date.today()
    names = {int(k): v.get("name", "") for k, v in state.get("courses", {}).items()}
    items = [i for i in build(index_db, events, deadlines, today, names) if i["course_id"] in names]
    save({"updated": now or int(time.time()), "items": items})
    return {"count": len(items)}
