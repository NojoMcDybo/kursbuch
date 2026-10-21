"""Inhalte ohne Datei (content.py): Parser gegen nachgebaute LearnWeb-Seiten (erfundene Namen, keine echten Daten) und der Abruf mit
einem simulierten LearnWeb: sparsam (nur neue Themen, Dozenten nur alle 14 Tage), Fehler zaehlen statt kippen."""
import httpx
from hypothesis import given, settings
from hypothesis import strategies as st

from learnweb import content
from learnweb.client import LearnWebError

BASE = "https://lw.example/learnweb2"


# --------------------------------------------------------------------------- HTML -> Text

def test_html_text_keeps_paragraphs_lists_and_collects_absolute_links():
    html = ('<div><h3>Titel</h3><p>Hallo&nbsp;zusammen,<br>bitte <a href="mod/x?id=1">hier</a> und <a href="https://t.example/x">Teams</a> '
            'lesen.</p><ul><li>Punkt 1</li><li>Punkt <b>2</b></li></ul><script>alert(1)</script><style>p{}</style>'
            '<a href="javascript:alert(1)">böse</a><a href="mailto:a@b.de">Mail</a><a href="mod/x?id=1">doppelt</a></div>')
    text, links = content.html_text(html, BASE + "/")
    assert text == "Titel\n\nHallo zusammen,\nbitte hier und Teams lesen.\n\n- Punkt 1\n- Punkt 2\n\nböseMaildoppelt"
    assert [link["url"] for link in links] == [BASE + "/mod/x?id=1", "https://t.example/x", "mailto:a@b.de"]  # kein javascript:, keine Doppelten
    assert "alert" not in text and "p{}" not in text


def test_html_text_edge_cases():
    assert content.html_text(None) == ("", []) and content.html_text("") == ("", [])
    assert content.html_text("nur Text")[0] == "nur Text"
    assert content.html_text("<p>a &amp; b &lt;c&gt;</p>")[0] == "a & b <c>"
    long = "<p>" + "Zeile</p><p>".join(["x" * 100] * 200) + "</p>"
    text, _ = content.html_text(long)
    assert len(text) <= content.MAX_TEXT + 2 and text.endswith("…")


@settings(max_examples=300, deadline=None)
@given(st.lists(st.sampled_from(["<", ">", "/", "=", chr(34), " ", "a", "b", "x", "&", ";", "#", "A0", "-", chr(10), chr(13), chr(9), "<p>", "</p>", "<a href=", "<li>", "<script>", "</a>", "&nbsp;", "&amp;", "<br>"]), max_size=40).map("".join))
def test_html_text_never_raises_and_keeps_its_shape(raw):
    text, links = content.html_text(raw, BASE)
    assert "\r" not in text and "\n\n\n" not in text and len(text) <= content.MAX_TEXT + 2 and text == text.strip()
    assert len(links) <= 20 and all(link["url"].startswith(("http://", "https://", "mailto:")) for link in links)


# --------------------------------------------------------------------------- Seiten

FORUM = ('<tr><td><a class="w-100" href="https://lw.example/learnweb2/mod/forum/discuss.php?d=519023" title="Teams" aria-label="Teams">Teams</a></td></tr>'
         '<tr><td><a href="https://lw.example/learnweb2/mod/forum/discuss.php?d=519023">Teams</a></td></tr>'
         '<tr><td><a title="Raum &amp; Zeit" href="https://lw.example/learnweb2/mod/forum/discuss.php?d=531438&amp;parent=1">x</a></td></tr>'
         '<a href="https://lw.example/learnweb2/mod/forum/view.php?id=5">kein Thema</a>')


def test_forum_list_finds_each_discussion_once_with_its_title():
    assert content.forum_discussions(FORUM) == [{"id": 519023, "title": "Teams"}, {"id": 531438, "title": "Raum & Zeit"}]
    assert content.forum_discussions("") == []


def test_news_forums_are_picked_by_name_not_the_student_question_forums():
    entry = {"cms": {"1": {"typ": "forum", "name": "Nachrichten und Ankündigungen"}, "2": {"typ": "forum", "name": "Questions (task sheets)"},
                     "3": {"typ": "forum", "name": "News and announcements"}, "4": {"typ": "resource", "name": "Announcements.pdf"}, "5": {"typ": "forum", "name": "Forum: updates"}}}
    assert [k for k, _ in content.news_forums(entry)] == [1, 3, 5]


POSTS = {"posts": [{"id": 8, "discussionid": 5, "subject": "Hallo &amp; willkommen", "timecreated": 1776263338, "isdeleted": False,
                    "author": {"id": 3, "fullname": "Dr. Erika Beispiel"}, "message": "<p>Bitte <a href=\"https://t.example/x\">hier</a> eintragen.</p>",
                    "attachments": [{"filename": "a.pdf", "fileurl": "https://lw.example/f/a.pdf"}, {"filename": "ohne"}], "urls": {"view": "https://lw.example/d#p8"}},
                   {"id": 9, "isdeleted": True, "message": "weg"}, {"id": 10, "isprivatereply": True, "message": "privat"}]}


def test_posts_become_entries_without_deleted_or_private_ones():
    (p,) = content.parse_posts(POSTS, 77, "News", BASE + "/")
    assert (p["id"], p["forum"], p["title"], p["author"], p["ts"], p["url"]) == (8, 77, "Hallo & willkommen", "Dr. Erika Beispiel", 1776263338, "https://lw.example/d#p8")
    assert p["text"] == "Bitte hier eintragen." and p["links"][0]["url"] == "https://t.example/x" and p["files"] == [{"name": "a.pdf", "url": "https://lw.example/f/a.pdf"}]
    assert content.parse_posts({}, 1, "x", "") == [] and content.parse_posts(None, 1, "x", "") == []


ASSIGN = ('<div id="intro" class="box"><div class="no-overflow"><p>Erstelle eine <b>Mind-Map</b>.</p></div></div></div>'
          '<div data-region="activity-dates"><div>Geöffnet: Mittwoch, 14. Oktober 2026, 11:40</div><div>Fällig: Freitag, 23. Oktober 2026, 23:59</div></div></div>'
          '<table><tr><th class="cell c0">Abgabestatus</th><td class="cell c1">Bisher wurden keine Aufgaben abgegeben</td></tr>'
          '<tr><th class="cell c0">Bewertungsstatus</th><td class="cell c1">Nicht bewertet</td></tr>'
          '<tr><th class="cell c0">Verbleibende Zeit</th><td class="cell c1">Verbleibend: 4 Tage 7 Stunden</td></tr></table>')


def test_assignment_page_gives_text_dates_and_status():
    a = content.parse_assign(ASSIGN, BASE + "/")
    assert a["intro"] == "Erstelle eine Mind-Map."
    assert (a["opens"], a["due"]) == ("Mittwoch, 14. Oktober 2026, 11:40", "Freitag, 23. Oktober 2026, 23:59")
    assert (a["status"], a["grading"], a["remaining"]) == ("Bisher wurden keine Aufgaben abgegeben", "Nicht bewertet", "Verbleibend: 4 Tage 7 Stunden")
    empty = content.parse_assign("<html></html>")
    assert empty["intro"] == "" and empty["due"] is None and empty["status"] == ""


def row(uid, name, role, n=1):
    return (f'<tr class="" id="user-index-participants-5_r{n}"><td class="cell c0"><input type="checkbox"></td>'
            f'<th class="cell c1" scope="row"><a href="https://lw.example/learnweb2/user/view.php?id={uid}&amp;course=5"><img src="x">{name}</a></th>'
            f'<td class="cell c2">{role}</td><td class="cell c3">Keine Gruppen</td></tr>')


def test_participants_keep_only_teachers_and_tutors_never_students():
    page = row(11, "Dr. Erika Beispiel", "Lehrende/r") + row(12, "Max Muster", "Studierende/r", 2) + row(13, "Tina Tutor", "Tutor zur Betreuung von Übungen", 3) + row(14, "Leer", "", 4)
    assert content.parse_participants(page) == [{"id": 11, "name": "Dr. Erika Beispiel", "role": "Lehrende/r"}, {"id": 13, "name": "Tina Tutor", "role": "Tutor zur Betreuung von Übungen"}]
    assert content.parse_participants("") == []


PROFILE = ('<div class="profile_tree"><section><ul><li class="contentnode"><dl><dt>E-Mail-Adresse</dt><dd><a href="&#109;a&#105;&#108;&#116;o:e%72ika@%75ni%2dx%2ede">'
           '&#101;rika&#46;beispiel&#64;uni&#45;x&#46;de</a></dd></dl></li><li class="contentnode"><dl><dt>Land</dt><dd>Deutschland</dd></dl></li>'
           '<li class="contentnode"><dl><dt>Zeitzone</dt><dd>Europe/Berlin</dd></dl></li><li class="contentnode"><dl><dt>Rollen</dt><dd>Lehrende/r</dd></dl></li></ul></section></div>')


def test_profile_decodes_the_obfuscated_email_and_keeps_other_fields():
    p = content.parse_profile(PROFILE)
    assert p == {"email": "erika.beispiel@uni-x.de", "fields": {"Land": "Deutschland"}}
    assert content.parse_profile("") == {"email": None, "fields": {}}
    english = ('<dl><dt>Email address</dt><dd>a.b@uni-x.de</dd></dl><dl><dt>Timezone</dt><dd>Europe/Berlin</dd></dl><dl><dt>Roles</dt><dd>Teacher</dd></dl>'
               '<dl><dt>City</dt><dd>Münster</dd></dl>')
    assert content.parse_profile(english) == {"email": "a.b@uni-x.de", "fields": {"City": "Münster"}}


def test_found_contacts_skip_the_teachers_own_address_and_name_the_source():
    entry = {"cms": {"1": {"typ": "label", "name": "Sprechstunde: sekretariat@uni-x.de oder erika.beispiel@uni-x.de", "section": "Organisation"}, "2": {"typ": "resource", "name": "x@y.de"}}}
    news = [{"title": "Raum", "text": "Fragen an Tina@Uni-X.de"}]
    out = content.found_contacts(entry, news, [{"name": "Essay", "intro": "Abgabe an essay@uni-x.de"}], [{"email": "erika.beispiel@uni-x.de"}])
    assert out == [{"email": "sekretariat@uni-x.de", "where": "Text im Kurs (Organisation)"}, {"email": "tina@uni-x.de", "where": "Ankündigung „Raum“"},
                   {"email": "essay@uni-x.de", "where": "Aufgabe „Essay“"}]


# --------------------------------------------------------------------------- Abruf mit simuliertem LearnWeb

class Url:
    def __init__(self, path):
        self.path = path


class Resp:
    def __init__(self, text="", code=200, path="/learnweb2/page.php"):
        self.text, self.status_code, self.url = text, code, Url(path)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("x", request=httpx.Request("GET", "u"), response=httpx.Response(self.status_code))


class Http:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, url, params=None):
        key = (url.split("/learnweb2/")[1], tuple(sorted((params or {}).items())))
        self.calls.append(key)
        return self.pages.get(key, Resp("", 404))


class FakeLW:
    base = BASE
    logins = 0

    def _ensure_session(self):
        pass

    def login(self):
        self.logins += 1

    def __init__(self, pages=None):
        self.http = Http(pages if pages is not None else {
            ("mod/forum/view.php", (("id", 7),)): Resp(FORUM),
            ("mod/assign/view.php", (("id", 9),)): Resp(ASSIGN),
            ("user/index.php", (("id", 5), ("roleid", 3))): Resp(row(11, "Dr. Erika Beispiel", "Lehrende/r")),
            ("user/index.php", (("id", 5), ("roleid", 9))): Resp(""),
            ("user/index.php", (("id", 5), ("roleid", 4))): Resp(row(12, "Max Muster", "Studierende/r")),  # Rolle ohne Mitglieder zeigt Studierende
            ("user/view.php", (("course", 5), ("id", 11))): Resp(PROFILE),
        })
        self.posts = []

    def ajax(self, method, args):
        self.posts.append((method, args["discussionid"]))
        return {"posts": [{"id": args["discussionid"], "discussionid": args["discussionid"], "subject": f"Thema {args['discussionid']}", "timecreated": args["discussionid"],
                           "author": {"id": 11, "fullname": "Dr. Erika Beispiel"}, "message": "<p>Text</p>"}]}


ENTRY = {"id": 5, "cms": {"7": {"typ": "forum", "name": "Nachrichten und Ankündigungen", "url": "u"}, "9": {"typ": "assign", "name": "Aufgabe 1", "url": "ua"},
                          "8": {"typ": "forum", "name": "Fragen"}}}
NOW = 1_800_000_000


def test_first_run_collects_news_assignment_and_teachers_but_no_students():
    lw = FakeLW()
    c, errors = content.collect_course(lw, ENTRY, {}, 0, NOW)
    assert errors == 0
    assert [n["discussion"] for n in c["news"]] == [531438, 519023] and [m for m, _ in lw.posts] == ["mod_forum_get_discussion_posts"] * 2
    assert c["assignments"][0]["cmid"] == 9 and c["assignments"][0]["status"].startswith("Bisher")
    assert [(t["id"], t["email"]) for t in c["teachers"]] == [(11, "erika.beispiel@uni-x.de")]
    assert c["teachers"][0]["source"].startswith("LearnWeb") and c["teachers"][0]["checked"] == NOW and c["teachers_at"] == NOW
    assert not any("Max Muster" in repr(c) for _ in [0])


def test_second_run_fetches_only_new_discussions_and_keeps_fresh_teachers():
    lw = FakeLW()
    first, _ = content.collect_course(lw, ENTRY, {}, 0, NOW)
    lw2 = FakeLW()
    again, _ = content.collect_course(lw2, ENTRY, first, 0, NOW + 3600)
    assert lw2.posts == [] and [n["id"] for n in again["news"]] == [n["id"] for n in first["news"]]  # keine Beitraege nachgeladen
    assert not any(call[0].startswith("user/") for call in lw2.http.calls)  # Dozenten frisch: keine Anfrage
    assert [c[0] for c in lw2.http.calls] == ["mod/forum/view.php", "mod/assign/view.php"]
    stale, _ = content.collect_course(FakeLW(), ENTRY, first, 0, NOW + 15 * 86400)
    assert stale["teachers_at"] == NOW + 15 * 86400  # nach 14 Tagen neu
    forced, _ = content.collect_course(FakeLW(), ENTRY, first, 0, NOW + 60, force=True)
    assert forced["teachers_at"] == NOW + 60


def test_errors_are_counted_and_old_teachers_survive_an_incomplete_fetch():
    first, _ = content.collect_course(FakeLW(), ENTRY, {}, 0, NOW)
    pages = {("mod/forum/view.php", (("id", 7),)): Resp("", 500), ("mod/assign/view.php", (("id", 9),)): Resp("", 404)}
    bad = FakeLW(pages)
    c, errors = content.collect_course(bad, ENTRY, first, 0, NOW + 20 * 86400)
    assert errors >= 5  # Forum, Aufgabe und alle drei Rollenlisten
    assert [t["id"] for t in c["teachers"]] == [11] and c["teachers_at"] == first["teachers_at"]  # alter Stand bleibt
    assert [n["id"] for n in c["news"]] == [n["id"] for n in first["news"]]


def test_ajax_errors_in_one_forum_do_not_stop_the_course():
    lw = FakeLW()
    lw.ajax = lambda m, a: (_ for _ in ()).throw(LearnWebError("servicenotavailable"))
    c, errors = content.collect_course(lw, ENTRY, {}, 0, NOW)
    assert errors == 1 and c["news"] == [] and c["assignments"] and c["teachers"]


def test_update_saves_after_each_course_and_drops_courses_that_left_the_state():
    saved = []
    state = {"courses": {"5": ENTRY}}
    old = {"courses": {"5": {}, "99": {"news": [{"discussion": 1}]}}}
    res = content.update(FakeLW(), state, lambda: old, saved.append, 0, NOW)
    assert res == {"courses": 1, "news": 2, "assignments": 1, "teachers": 1, "errors": 0}
    assert "99" not in saved[-1]["courses"] and saved[-1]["updated"] == NOW and len(saved) == 2  # nach dem Kurs und am Ende


def test_a_redirect_to_the_login_page_logs_in_once_and_then_counts_as_an_error_not_as_an_empty_hit():
    login = Resp("<form>login</form>", path="/learnweb2/login/index.php")
    lw = FakeLW({("mod/forum/view.php", (("id", 7),)): login, ("mod/assign/view.php", (("id", 9),)): login})
    c, errors = content.collect_course(lw, ENTRY, {}, 0, NOW)
    assert c["news"] == [] and c["assignments"] == [] and errors >= 2  # nicht „9 Aufgaben ohne Angaben“
    assert lw.logins >= 2  # je Seite ein Anmeldeversuch
    ok = FakeLW()
    assert content._page(ok, "mod/forum/view.php", 0, id=7) == FORUM and ok.logins == 0
