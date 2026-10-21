"""Offline-Tests gegen ein simuliertes LearnWeb (httpx.MockTransport).

    uv run --with pytest pytest -q
"""
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from learnweb.client import BASE, Credentials, LearnWeb, LoginError  # noqa: E402

LOGIN_PAGE = """<html><script>M.cfg = {"wwwroot":"x","sesskey":"ANONKEY"};</script>
<form action="%s/login/index.php" method="post" id="login">
  <input type="text" name="username"><input type="password" name="password">
  <input type="hidden" name="anchor" value="">
  <input type="hidden" name="logintoken" value="REALTOKEN">
</form>
<form id="guestlogin"><input type="hidden" name="logintoken" value="GUESTTOKEN"></form>
%s</html>"""
MY_PAGE = '<html><script>M.cfg = {"wwwroot":"x","sesskey":"KEY%d"};</script><a href="logout.php">x</a></html>'


class FakeLearnWeb:
    def __init__(self, password="richtig", expire_after=None):
        self.password = password
        self.logins = 0
        self.ajax_calls = 0
        self.expire_after = expire_after  # nach N AJAX-Calls Session "ablaufen" lassen
        self.posted_tokens = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        p = req.url.path.replace("/LearnWeb/learnweb2", "")
        authed = "MoodleSession=ok" in req.headers.get("cookie", "")

        if p == "/login/index.php" and req.method == "GET":
            return httpx.Response(200, text=LOGIN_PAGE % (BASE, ""), headers={"set-cookie": "MoodleSession=anon; path=/"})
        if p == "/login/index.php" and req.method == "POST":
            form = dict(x.split("=", 1) for x in req.content.decode().split("&"))
            self.posted_tokens.append(form["logintoken"])
            if form["password"] != self.password:
                return httpx.Response(200, text=LOGIN_PAGE % (BASE, '<div id="loginerrormessage" class="alert">Ungültige Anmeldedaten</div>'))
            self.logins += 1
            return httpx.Response(303, headers={"location": f"{BASE}/my/", "set-cookie": "MoodleSession=ok; path=/"})
        if p == "/my/":
            if not authed:
                return httpx.Response(303, headers={"location": f"{BASE}/login/index.php"})
            return httpx.Response(200, text=MY_PAGE % self.logins)
        if p == "/lib/ajax/service.php":
            self.ajax_calls += 1
            if self.expire_after is not None and self.ajax_calls > self.expire_after and req.url.params["sesskey"] == "KEY1":
                return httpx.Response(200, json={"error": "x", "errorcode": "invalidsesskey"})
            body = json.loads(req.content)[0]
            return httpx.Response(200, json=[{"error": False, "data": self.ajax(body["methodname"])}])
        if p == "/mod/resource/view.php":
            return httpx.Response(303, headers={"location": f"{BASE}/pluginfile.php/1/mod_resource/content/1/x.pdf"})
        if p.startswith("/pluginfile.php"):
            name = p.rsplit("/", 1)[-1]
            hdr = {"content-disposition": "attachment; filename*=UTF-8''Folien%20%C3%9Cbung%201.pdf"} if name == "x.pdf" else {}
            return httpx.Response(200, content=b"%PDF-" + name.encode(), headers=hdr)
        if p == "/mod/folder/view.php":
            links = "".join(f'<a href="{BASE}/pluginfile.php/9/mod_folder/content/0/{n}?forcedownload=1">{n}</a>' for n in ["a.pdf", "b.docx", "a.pdf"])
            return httpx.Response(200, text=f"<html>{links}</html>")
        return httpx.Response(404)

    def ajax(self, method):
        if method == "core_course_get_enrolled_courses_by_timeline_classification":
            return {"courses": [{"id": 7, "fullname": "Theorizing &amp; Queerness", "shortname": "TQ", "coursecategory": "Anglistik",
                                 "isfavourite": True, "hasprogress": False, "viewurl": "u"}], "nextoffset": 1}
        if method == "core_courseformat_get_state":
            return json.dumps({
                "course": {"id": "7", "sectionlist": ["11", "10"]},
                "section": [{"id": "10", "title": "Woche 1", "number": 1, "cmlist": ["100", "101"], "hassummary": False},
                            {"id": "11", "title": "Allgemeines", "number": 0, "cmlist": ["102"], "hassummary": False}],
                "cm": [{"id": "100", "name": "Folien", "module": "resource", "url": "u1", "uservisible": True},
                       {"id": "101", "name": "Versteckt", "module": "quiz", "url": "u2", "uservisible": False},
                       {"id": "102", "name": "Forum", "module": "forum", "url": "u3", "uservisible": True}],
            })
        return {}


def client(fake, tmp_path=None):
    return LearnWeb(Credentials("abc123", lambda: "richtig"), transport=httpx.MockTransport(fake))


def test_login_uses_login_form_token_and_gets_sesskey():
    fake = FakeLearnWeb()
    lw = client(fake)
    lw.login()
    assert fake.posted_tokens == ["REALTOKEN"]
    assert lw.sesskey == "KEY1"


def test_wrong_password_raises_with_message():
    lw = client(FakeLearnWeb(password="anders"))
    with pytest.raises(LoginError, match="Ungültige Anmeldedaten"):
        lw.login()


def test_courses_lazy_login_and_unescape():
    fake = FakeLearnWeb()
    kurse = client(fake).courses()
    assert fake.logins == 1
    assert kurse[0]["name"] == "Theorizing & Queerness" and kurse[0]["favorit"]


def test_expired_session_relogins_once():
    fake = FakeLearnWeb(expire_after=1)
    lw = client(fake)
    lw.courses()
    lw.courses()  # zweiter Call: invalidsesskey -> Re-Login -> Erfolg
    assert fake.logins == 2 and lw.sesskey == "KEY2"


def test_course_contents_order_strings_and_hidden():
    c = client(FakeLearnWeb()).course_contents(7)
    assert [s["abschnitt"] for s in c["abschnitte"]] == ["Allgemeines", "Woche 1"]
    woche1 = c["abschnitte"][1]["inhalte"]
    assert woche1 == [{"cmid": 100, "name": "Folien", "typ": "resource", "url": "u1"}]


def test_download_resource_uses_content_disposition(tmp_path):
    files = client(FakeLearnWeb()).download(100, "resource", tmp_path)
    assert files[0].name == "Folien Übung 1.pdf"
    assert files[0].read_bytes().startswith(b"%PDF-")


def test_download_folder_dedupes(tmp_path):
    files = client(FakeLearnWeb()).download(9, "folder", tmp_path)
    assert sorted(f.name for f in files) == ["a.pdf", "b.docx"]


@pytest.mark.parametrize("name", ["CON", "nul.pdf", "Aux.tar.gz", "COM1.docx", "lpt9"])
def test_windows_device_names_never_become_file_names(name):
    from learnweb.client import safe_filename
    assert safe_filename(name) == "_" + name
    assert safe_filename("Console.pdf") == "Console.pdf" and safe_filename("com10.pdf") == "com10.pdf"


def test_download_rejects_other_types(tmp_path):
    from learnweb.client import LearnWebError
    with pytest.raises(LearnWebError, match="nur für"):
        client(FakeLearnWeb()).download(1, "quiz", tmp_path)
