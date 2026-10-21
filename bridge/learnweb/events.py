"""Termine aus den Kursdaten, ohne KI: Daten in Abschnittstiteln (Sitzungen) und Label-Texten (Fristen, Pruefungen).

    uv run python -m learnweb.cli events        # aus data/sync_state.json neu bauen, kein LearnWeb-Zugriff

Ergebnis (data/events.json, von sync.py geschrieben): {"updated": <Unix>, "items": [Termin, ...]}, Termin =
    {id, ts (Unix, Ortszeit), day (lokales Datum, ISO), all_day, kind, title, short, course_id, cmid|null, source}
    short = title ohne Datum (nur bei Abschnittstiteln; Label-Texte bleiben, wie sie sind)
    kind: sitzung | frist | pruefung | termin        source: abschnitt | label

Das Jahr fehlt meist ("12 October"). Es folgt aus dem Semester des Kurses (WiSe 2026/27: Sep-Dez 2026, Jan-Aug 2027;
SoSe 2026: 2026); ohne Semester gilt das Datum, das dem Stichtag am naechsten liegt. Unsichere Funde werden lieber
ausgelassen ("may" nur gross geschrieben, "Session 2, 12 October" ist der 12., nicht auch der 2.). Die spaetere KI-Suche
(Laya) ergaenzt Vorschlaege, die erst nach Bestaetigung zaehlen.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import date, datetime

_MONTH = (r"(?:Jan(?:uary|uar)?|Feb(?:ruary|ruar)?|M(?:ar(?:ch)?|ärz|aerz|rz)|Apr(?:il)?|Ma[iy]|Jun[ei]?|Jul[iy]?|"
          r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|O[ck]t(?:ober)?|Nov(?:ember)?|De[cz](?:ember)?)")
_NUM = {"jan": 1, "feb": 2, "mar": 3, "mär": 3, "mae": 3, "mrz": 3, "apr": 4, "may": 5, "mai": 5, "jun": 6, "jul": 7, "aug": 8,
        "sep": 9, "okt": 10, "oct": 10, "nov": 11, "dez": 12, "dec": 12}
# Aufzaehlung "12 & 19 October" (beide Tage) und Bereich "12-16 October" (der Beginn); Komma und " - " bedeuten hier nichts
_LIST = r"\s*(?:&|and|und)\s*"
_RANGE = r"(?:[-–—]|\s+(?:bis|to)\s+)"

_ISO = re.compile(r"(?<![\d.])(\d{4})-(\d{2})-(\d{2})(?!\d)")
_DOT = re.compile(r"(?<![\w.])(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?!\d)|(?!\d))")
_DMON = re.compile(
    rf"(?<![\w.])(?:(\d{{1,2}})(?:st|nd|rd|th)?\.?(?P<sep>{_LIST}|{_RANGE}))?"
    rf"(\d{{1,2}})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?(?P<mon>{_MONTH})\b\.?(?:,?\s*(\d{{4}})(?!\d))?", re.I)
_MOND = re.compile(rf"(?<!\w)(?P<mon>{_MONTH})\b\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?!\d)(?:,?\s*(\d{{4}})(?!\d))?", re.I)
# "14:30 Uhr", "11.00 Uhr bis 20:00 Uhr", "10 a.m.", "12 noon" - oder ein blosses "10:00" (mit Doppelpunkt eindeutig)
_TIME = re.compile(
    r"^[\s,;:|(–-]*(?:at|um|ab|from|ca\.?|gegen)?\s*"
    r"(?:(\d{1,2})(?:[:.](\d{2}))?\s*(?P<u>Uhr|h\b|a\.?m\.?|p\.?m\.?|noon)|(\d{1,2}):(\d{2})(?![\d:.]))", re.I)


@dataclass(frozen=True)
class Hit:
    start: int
    end: int
    day: int
    month: int
    year: int | None  # 4-stellig oder None


def _month(name: str) -> int | None:
    n = name.lower().rstrip(".")
    if n == "may" and name[0] != "M":  # "may" als Verb: nur gross geschrieben als Monat zaehlen
        return None
    return _NUM.get(n[:3])


def _year(s: str | None) -> int | None:
    if not s:
        return None
    y = int(s)
    return y if y > 99 else 2000 + y


def find_dates(text: str) -> list[Hit]:
    """Alle Daten im Text, ohne Ueberlappung. Tag und Monat sind formal gueltig (1-31, 1-12), nicht kalendarisch geprueft."""
    cand: list[Hit] = []
    for m in _ISO.finditer(text):
        cand.append(Hit(m.start(), m.end(), int(m[3]), int(m[2]), int(m[1])))
    for m in _DOT.finditer(text):
        cand.append(Hit(m.start(), m.end(), int(m[1]), int(m[2]), _year(m[3])))
    for m in _DMON.finditer(text):
        mon, year = _month(m["mon"]), _year(m[5])
        if mon is None:
            continue
        if not m[1]:
            cand.append(Hit(m.start(), m.end(), int(m[3]), mon, year))
        elif re.fullmatch(_LIST, m["sep"], re.I):
            cand.append(Hit(m.start(), m.start(3), int(m[1]), mon, year))
            cand.append(Hit(m.start(3), m.end(), int(m[3]), mon, year))
        else:
            cand.append(Hit(m.start(), m.end(), int(m[1]), mon, year))
    for m in _MOND.finditer(text):
        mon = _month(m["mon"])
        if mon is not None:
            cand.append(Hit(m.start(), m.end(), int(m[2]), mon, _year(m[3])))
    out: list[Hit] = []
    for h in sorted((h for h in cand if 1 <= h.day <= 31 and 1 <= h.month <= 12), key=lambda h: (h.start, -(h.end - h.start))):
        if not out or h.start >= out[-1].end:  # frueh und lang gewinnt
            out.append(h)
    return out


def time_after(text: str, pos: int) -> tuple[int, int] | None:
    """Uhrzeit direkt hinter einem Datum: "14:00 Uhr", "14.30 h", "10 a.m.", "12 noon"."""
    m = _TIME.match(text[pos:pos + 24])
    if not m:
        return None
    if m["u"] is None:  # blosses HH:MM
        h, mi = int(m[4]), int(m[5])
        return (h, mi) if h < 24 and mi < 60 else None
    h, mi, u = int(m[1]), int(m[2] or 0), m["u"].lower().replace(".", "")
    if u == "noon":
        return (12, 0) if h == 12 else None
    if u in ("am", "pm"):
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if u == "pm" else 0)
    return (h, mi) if h < 24 and mi < 60 else None


def semester_of(course_name: str) -> tuple[str, int] | None:
    m = re.search(r"(?<![A-Za-z])(WiSe|SoSe)\s+(\d{4})", course_name)
    return (m[1], int(m[2])) if m else None


def _safe(year: int, h: Hit) -> date | None:
    try:
        return date(year, h.month, h.day)
    except ValueError:
        return None


def resolve(h: Hit, sem: tuple[str, int] | None, today: date) -> date | None:
    """Datum samt Jahr; None, wenn es den Kalendertag nicht gibt."""
    if h.year:
        return _safe(h.year, h)
    if sem:
        term, sy = sem
        return _safe(sy if term == "SoSe" or h.month >= 9 else sy + 1, h)
    near = [d for y in (today.year - 1, today.year, today.year + 1) if (d := _safe(y, h))]
    return min(near, key=lambda d: abs((d - today).days), default=None)


_EXAM = re.compile(r"\b(exam|klausur|prüfung|pruefung|test|quiz|colloquium|kolloquium)", re.I)
_DUE = re.compile(r"\b(deadline|due\b|abgabe|abgeben|submission|submit|einreich|frist|bis zum|spätestens|until)", re.I)


def kind_of(text: str, source: str) -> str:
    if _DUE.search(text):
        return "frist"
    if _EXAM.search(text):
        return "pruefung"
    return "sitzung" if source == "abschnitt" else "termin"


_WEEKDAY = re.compile(r"(?:Mo|Di|Mi|Do|Fr|Sa|So|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|"
                      r"Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\.?,?\s*$", re.I)


def clean_title(text: str, hits: list[Hit]) -> str:
    """Titel ohne die Daten (und den Wochentag davor): "12 October: Introduction" -> "Introduction",
    "Overview (15 October, digital-only session)" -> "Overview (digital-only session)"."""
    out, pos = [], 0
    for h in hits:
        before = text[pos:h.start]
        out.append(_WEEKDAY.sub("", before) if before.strip() else before)
        pos = h.end
    out.append(text[pos:])
    s = " ".join("".join(out).split())
    s = re.sub(r"\(\s*[,;:|–—-]*\s*\)", "", s)           # leere Klammern
    s = re.sub(r"\(\s*[,;:|–—-]+\s*", "(", s)             # "(, digital-only" -> "(digital-only"
    s = re.sub(r"\s*[,;:|–—-]+\s*\)", ")", s)
    s = re.sub(r"\s+([,;:)])", r"\1", s)
    s = re.sub(r"(?:\s*[-–—|:,;_]\s*){2,}(?!>)", " - ", s)  # Reste doppelter Trenner (ein Pfeil "-->" bleibt)
    s = re.sub(r"^[\s,;:|–—._-]+|[\s,;:|–—_-]+$", "", s)
    return " ".join(s.split())


def _events(text: str, sem, today: date, course_id: int, cmid: int | None, key: str, source: str) -> list[dict]:
    out, kind = [], kind_of(text, source)
    hits = find_dates(text)
    full = re.sub(r"\s+", " ", text).strip()[:160]
    # Abschnittstitel: Datum steht nur davor oder daneben, der Kurztitel laesst es weg; Label-Texte bleiben, wie sie sind
    short = (clean_title(text, hits) or full)[:160] if source == "abschnitt" else full
    for h in hits:
        d = resolve(h, sem, today)
        if not d:
            continue
        t = time_after(text, h.end)
        ts = int(time.mktime(datetime(d.year, d.month, d.day, *(t or (0, 0))).timetuple()))
        out.append({"id": f"{course_id}-{source[0]}{key}-{ts}", "ts": ts, "day": d.isoformat(), "all_day": t is None, "kind": kind,
                    "title": full, "short": short, "course_id": course_id, "cmid": cmid, "source": source})
    return out


def build(state: dict, today: date | None = None) -> list[dict]:
    """Termine aller Kurse im State: aus Abschnittstiteln (Sitzungen) und Label-Texten, nach Zeit sortiert."""
    today = today or date.today()
    items: dict[str, dict] = {}
    for c in state.get("courses", {}).values():
        sem = semester_of(c.get("name", ""))
        for i, (title, _) in enumerate(c.get("layout", [])):
            for e in _events(title or "", sem, today, c["id"], None, str(i), "abschnitt"):
                items[e["id"]] = e
        for cmid, cm in c.get("cms", {}).items():
            if cm.get("typ") == "label":
                for e in _events(cm.get("name") or "", sem, today, c["id"], int(cmid), cmid, "label"):
                    items[e["id"]] = e
    return sorted(items.values(), key=lambda e: (e["ts"], e["course_id"], e["id"]))
