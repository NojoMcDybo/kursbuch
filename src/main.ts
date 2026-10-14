/**
 * Kursbuch — LearnWeb im Nojo-Oekosystem. Hauptfenster: oben die Leiste (Konto, Semester, Notch-Zone, Lupe, Fensterknoepfe),
 * darunter eine grosse matte Flaeche mit runden oberen Ecken: Zeitstrahl, links die Kurse, in der Mitte der Stundenplan, rechts
 * Kalender und Abgaben. Kurse oeffnen in eigenen Fenstern (`?kurs=<id>`, coursewin.ts). Daten sind lokal (Python-Seite);
 * Deep Link kursbuch://heute | kurs/<id> | suche/<Begriff>.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, liquid, segments, windowControls } from "./nojo/nojo-ui";
import { api, type Ev, type Link, type NewItem, type Overview } from "./api";
import { Abgaben } from "./abgaben";
import { Account, loginForm } from "./account";
import { Calendar } from "./calendar";
import { Courses } from "./courses";
import { mountCourseWindow } from "./coursewin";
import { todayDay } from "./dates";
import { FocusScene } from "./focus";
import { Fog } from "./fog";
import { applyNotch, watchNotch } from "./notch-align";
import { initGrab, isFocus, isLocked, setFocus, setLocked } from "./scene";
import { isSearchKey, Search } from "./search";
import { Timeline } from "./timeline";
import { Timetable } from "./timetable";
import { act, el, fillIcons, hueHex, ico, menu, q, shortSem, toast } from "./ui";
import { mountPomodoroWidget, WIDGET_POS } from "./widget";
import "@fontsource-variable/nunito-sans";

let events: Ev[] = [];
let news: NewItem[] = [];
let signature = "";
let fog: Fog;
let tl: Timeline;
let cal: Calendar;
let abgaben: Abgaben;
let courses: Courses;
let tt: Timetable;
let account: Account;
let search: Search;
let focus: FocusScene;

const KEY_LOGIN = "kursbuch-login";
/** Farben des Anmeldebilds (es gibt noch keine Kurse, nach denen sich der Nebel richten koennte) */
const LOGIN_HUES = ["#6f8cff", "#bf5af2", "#ff6a88", "#30d1c0"];
const PHASE_HUES: Record<string, string[]> = { focus: ["#ffb09b", "#ff7a85", "#ffd08a"], short: ["#8fdcbc", "#5ec9d8", "#a8e6a1"], long: ["#8fdcbc", "#5ec9d8", "#a8e6a1"] };
const KEY_BG = "kursbuch-bg";

/** Semester-Segmente im Kopf: die zwei neuesten, die aelteren hinter „…“ (dort steht dann der gewaehlte Name) */
function renderSems() {
  const nav = q(".sems");
  const all = courses.semesters();
  nav.hidden = all.length < 2;
  const items = all.slice(0, 2).map((s) => {
    const b = el("button", s === courses.semester ? "active" : "");
    b.setAttribute("aria-pressed", String(s === courses.semester));
    b.title = s;
    b.textContent = shortSem(s);
    b.addEventListener("click", () => pickSemester(s));
    return b;
  });
  const rest = all.slice(2);
  if (rest.length) {
    const on = rest.includes(courses.semester);
    const more = el("button", on ? "active" : "");
    more.setAttribute("aria-pressed", String(on));
    more.title = "Frühere Semester";
    if (on) more.textContent = shortSem(courses.semester); else more.append(ico("more"));
    more.addEventListener("click", () => menu(more, rest.map((s) => ({ icon: s === courses.semester ? "check" as const : "kalender" as const, label: s, run: () => pickSemester(s) }))));
    items.push(more);
  }
  nav.replaceChildren(...items);
}

function pickSemester(s: string) {
  courses.setSemester(s);
  semesterChanged();
}

function semesterChanged() {
  renderSems();
  tint();
  tt.setSemester(courses.semester);
}

/** Nebel: im Anmeldebild bunt, im Fokus-Modus bei laufendem Timer in der Farbe der Phase (Pfirsich = Fokus, Mint = Pause), sonst in den Farben des Semesters */
function tint() {
  const phase = document.body.dataset.phase ?? "idle";
  const hues = isLocked() ? LOGIN_HUES : isFocus() && PHASE_HUES[phase] ? PHASE_HUES[phase] : courses.hues().map((h) => hueHex(h));
  fog.setColors(hues);
  document.body.classList.toggle("vivid", isLocked() || isFocus());
}

/** Hintergrund: der bewegte farbige Nebel oder ein weiches Beige (merkt sich die Wahl; das Widget liest sie ebenfalls) */
function applyBg(beige: boolean) {
  document.documentElement.dataset.bg = beige ? "beige" : "dyn";
  fog?.hold(beige);
  try { localStorage.setItem(KEY_BG, beige ? "beige" : "dyn"); } catch { /* egal */ }
}

function scenesChanged() {
  renderSems();
  tint();
}

/** Zugangsdaten gespeichert oder nicht: Anmeldebild bzw. die Ansicht. Beim Abmelden endet auch ein laufender Timer. */
function loginState(saved: boolean) {
  try { localStorage.setItem(KEY_LOGIN, saved ? "1" : "0"); } catch { /* egal */ }
  if (!saved && focus?.pomo.active) focus.pomo.stop();
  setLocked(!saved);
  if (saved) void refresh();
  scenesChanged();
}

function renderAll() {
  tl.setEvents(events);
  cal.setEvents(events);
  abgaben.render(events);
  tl.refresh();
}

/** Stand von Rust holen; nur bei Aenderung neu zeichnen (das Fenster bekommt oft den Fokus, die Ansicht bleibt dabei stehen) */
async function refresh() {
  const o = await api.overview().catch((e): Overview => ({ status: "error", error: typeof e === "string" ? e : "Der Stand von LearnWeb lässt sich nicht lesen.", last_run: null, courses: [] }));
  const [ev, nw] = await Promise.all([api.events().catch(() => [] as Ev[]), api.news().catch(() => [] as NewItem[])]);
  const sig = JSON.stringify([o, ev, nw]);
  if (sig === signature) return;
  signature = sig;
  events = ev;
  news = nw;
  account.setSync(o.last_run);
  courses.setOverview(o);
  courses.setNews(news);
  renderSems();
  renderAll();
  tint();
  tt.setSemester(courses.semester);
  tt.refresh();
}

async function go(l: Link) {
  if (l.view === "kurs") act(api.openCourse(l.arg));
  else if (l.view === "suche") search.open(l.arg);
  else if (l.view === "fokus") { if (!isLocked()) setFocus(true); scenesChanged(); }
  else if (l.view === "heute") {
    tl.today();
    cal.pick(todayDay());
  }
}

// ---------- Start ----------

async function main() {
  fillIcons();
  const win = getCurrentWindow();
  const syncWindow = async () => {
    const [max, full] = await Promise.all([win.isMaximized().catch(() => false), win.isFullscreen().catch(() => false)]);
    document.body.classList.toggle("max", !!max);
    document.body.classList.toggle("full", !!full);
  };
  const setFull = async (on: boolean) => { await win.setFullscreen(on).catch(() => {}); await syncWindow(); };
  windowControls({
    minimize: () => void win.minimize().catch(() => {}),
    toggleMaximize: () => void (document.body.classList.contains("full") ? setFull(false) : win.toggleMaximize().catch(() => {})),
    close: () => void win.close().catch(() => {}),
  });

  fog = new Fog();
  document.body.prepend(fog.el);

  const hueOf = (id: number | null) => courses.hueOf(id);
  const nameOf = (id: number | null) => courses.nameOf(id);
  const open = (id: number) => act(api.openCourse(id));
  const nextOf = (id: number) => events.filter((e) => e.course === id && e.ts >= Date.now() / 1000 - 3600).sort((a, b) => a.ts - b.ts)[0];

  // gemerkter Stand: wer zuletzt angemeldet war, sieht sofort die Ansicht (die Pruefung folgt im Hintergrund)
  let cached = false;
  try { cached = localStorage.getItem(KEY_LOGIN) === "1"; } catch { /* egal */ }
  if (!cached) document.body.classList.add("locked");
  account = new Account({ onChange: () => { signature = ""; void refresh(); }, onStatus: loginState });
  q("#acct-host").replaceWith(account.el);
  courses = new Courses({ onOpen: open, onRead: () => void refresh() });
  tl = new Timeline({ hueOf, nameOf, onOpen: open });
  cal = new Calendar({ hueOf, onPick: (day) => tl.focusDay(day) });
  abgaben = new Abgaben({ hueOf, nameOf, onOpen: open });
  tt = new Timetable({
    semester: () => courses.semester,
    courses: () => courses.inSemester(),
    card: (id) => courses.card(id),
    nextOf,
    newOf: courses.newOf,
    openCourse: open,
    openWeb: (id) => act(api.openWeb(id)),
  });
  search = new Search({
    hueOf, nameOf,
    semesterIds: () => courses.semesterIds(),
    semesterLabel: () => (courses.semester ? shortSem(courses.semester) : ""),
    reveal: (id, target) => api.openCourse(id, target?.cmid, target?.section),
    anchor: () => q(".find"),
    onToggle: (on) => fog.hold(on),
  });
  document.body.append(search.el);
  q(".find").addEventListener("click", () => search.open());

  // Szenen hinter der dunklen Flaeche: Anmeldebild und Fokus-Ansicht
  const lg = el("section", "lg");
  const card = el("div", "lg-card n-glass n-liquid panel");
  const brand = el("div", "lg-brand");
  brand.append(ico("kursbuch", 30), el("b", "", "Kursbuch"), el("span", "", "mit LearnWeb anmelden"));
  card.append(brand, loginForm(() => void account.refresh()));
  lg.append(card);
  // der Timer laeuft in einem eigenen Widget-Fenster ohne Rahmen (immer oben); die gemerkte Lage geht mit
  focus = new FocusScene((on) => {
    let pos: { x?: number; y?: number } = {};
    try { pos = JSON.parse(localStorage.getItem(WIDGET_POS) ?? "{}"); } catch { /* egal */ }
    void api.pomodoroWidget(on, pos.x, pos.y).catch((e) => toast(typeof e === "string" ? e : "Das Widget ließ sich nicht öffnen."));
  });
  let lastPhase = "";
  focus.pomo.subscribe(() => { // Farbe des Nebels folgt der Phase des Timers
    const k = focus.pomo.status === "idle" ? "idle" : focus.pomo.phase;
    if (k !== lastPhase) { lastPhase = k; tint(); }
  });
  lg.dataset.tauriDragRegion = "";
  q("#scene").append(lg, focus.el);
  initGrab(q(".sheet"), q(".grab"), scenesChanged);
  q(".fbtn").addEventListener("click", () => { setFocus(!isFocus()); scenesChanged(); });
  q(".bgbtn").addEventListener("click", () => applyBg(document.documentElement.dataset.bg !== "beige"));
  let beige = false;
  try { beige = localStorage.getItem(KEY_BG) === "beige"; } catch { /* egal */ }
  applyBg(beige);
  void document.fonts?.ready.then(() => tl.refresh()); // der Zeitstrahl zeichnet mit der Schrift

  q("#tl-host").append(tl.el);
  q("#slot-l").append(courses.el);
  q("#slot-c").append(tt.el);
  q("#slot-r").append(cal.el, abgaben.el);

  glassLight();
  liquid();
  segments(document, ".n-seg");
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  // Kalender und Abgaben als Schublade in schmalen Fenstern
  const scrim = q(".scrim");
  const closeDrawer = () => { document.body.classList.remove("dr"); scrim.hidden = true; };
  document.querySelectorAll<HTMLButtonElement>(".drawer").forEach((b) => b.addEventListener("click", () => {
    const on = !document.body.classList.contains("dr");
    closeDrawer();
    document.body.classList.toggle("dr", on);
    scrim.hidden = !on;
  }));
  scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (isSearchKey(e)) { e.preventDefault(); search.open(); return; }
    if (e.key === "Escape") { if (document.body.classList.contains("dr")) closeDrawer(); else if (isFocus()) { setFocus(false); scenesChanged(); } else if (document.body.classList.contains("full")) void setFull(false); }
    if (e.key === "F11") { e.preventDefault(); void setFull(!document.body.classList.contains("full")); }
  });

  watchNotch([(cb) => void win.onResized(cb).catch(() => {}), (cb) => void win.onMoved(cb).catch(() => {})]);
  void account.refresh(); // Zugangsdaten-Stand (Anmeldebild oder Ansicht)
  await refresh();
  tint();
  applyNotch();

  await listen<Link>("open-link", (e) => { void api.takePending(); void go(e.payload); });
  const pending = await api.takePending().catch(() => null);
  if (pending) await go(pending);
  window.addEventListener("focus", () => void refresh());
  // Restzeiten und „heute“ nachziehen
  window.setInterval(() => { abgaben.render(events); tl.refresh(); }, 60_000);
}

const params = new URLSearchParams(location.search);
const course = Number(params.get("kurs"));
if (params.get("widget") === "pomodoro") {
  document.getElementById("dash")?.remove();
  try { document.documentElement.dataset.bg = localStorage.getItem(KEY_BG) === "beige" ? "beige" : "dyn"; } catch { /* egal */ }
  void mountPomodoroWidget();
} else if (params.has("kurs") && Number.isInteger(course) && course > 0) {
  document.getElementById("dash")?.remove();
  const cmid = Number(params.get("cmid"));
  void mountCourseWindow(course, { cmid: Number.isInteger(cmid) && cmid > 0 ? cmid : null, section: params.get("sec") });
} else {
  void main();
}
