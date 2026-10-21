/**
 * Kursbuch — LearnWeb im Nojo-Oekosystem. Hauptfenster: oben die Leiste (Konto, Semester, Notch-Zone, Lupe, Fensterknoepfe),
 * darunter eine grosse matte Flaeche mit runden oberen Ecken: Zeitstrahl, links die Kurse, in der Mitte der Stundenplan, rechts
 * die Abgaben. Kurse oeffnen in eigenen Fenstern (`?kurs=<id>`, coursewin.ts). Daten sind lokal (Python-Seite);
 * Deep Link kursbuch://heute | kurs/<id> | suche/<Begriff>.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, liquid, segments, windowControls } from "./nojo/nojo-ui";
import { api, type Ev, type Link, type NewItem, type Overview } from "./api";
import { Abgaben } from "./abgaben";
import { Account, loginForm } from "./account";
import { Courses } from "./courses";
import { CourseLayer } from "./courselayer";
import type { Target as CourseTarget } from "./coursepage";
import { mountCourseWindow } from "./coursewin";
import { todayDay } from "./dates";
import { FocusScene } from "./focus";
import { Fog } from "./fog";
import { applyNotch, watchNotch } from "./notch-align";
import { initGrab, isFocus, isLocked, setFocus, setLocked } from "./scene";
import { isSearchKey, Search } from "./search";
import { SyncUi } from "./syncui";
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
let abgaben: Abgaben;
let courses: Courses;
let tt: Timetable;
let account: Account;
let search: Search;
let focus: FocusScene;
let clay: CourseLayer;
let sync: SyncUi;

const KEY_LOGIN = "kursbuch-login";
/** Farben des Anmeldebilds (es gibt noch keine Kurse, nach denen sich der Nebel richten koennte) */
const LOGIN_HUES = ["#6f8cff", "#bf5af2", "#ff6a88", "#30d1c0"];
const PHASE_HUES: Record<string, string[]> = { focus: ["#ffb09b", "#ff7a85", "#ffd08a"], short: ["#8fdcbc", "#5ec9d8", "#a8e6a1"], long: ["#8fdcbc", "#5ec9d8", "#a8e6a1"] };
const KEY_BG = "kursbuch-bg";
/** Pomodoro-Widget in der App ausgeblendet (der Timer laeuft weiter, nur das Fenster bleibt zu) */
const KEY_WHIDE = "kursbuch-widget-hidden";
const widgetHidden = () => { try { return localStorage.getItem(KEY_WHIDE) === "1"; } catch { return false; } };
/** nach so vielen Stunden ohne Abgleich gleicht die App beim Start von selbst ab */
const STALE_H = 20;

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
  paintWidgetBtn();
  if (isFocus() || isLocked()) clay?.close(); // der Kurs-Layer gehoert zur Ansicht, nicht zum Fokus-Modus oder zum Anmeldebild
}

/** Widget-Fenster oeffnen/schliessen; die gemerkte Lage geht mit */
function setWidget(on: boolean) {
  let pos: { x?: number; y?: number } = {};
  try { pos = JSON.parse(localStorage.getItem(WIDGET_POS) ?? "{}"); } catch { /* egal */ }
  void api.pomodoroWidget(on, pos.x, pos.y).catch((e) => toast(typeof e === "string" ? e : "Das Widget ließ sich nicht öffnen."));
}

function toggleWidget(hide = !widgetHidden()) {
  try { localStorage.setItem(KEY_WHIDE, hide ? "1" : "0"); } catch { /* egal */ }
  setWidget(!hide && focus.pomo.active);
  paintWidgetBtn();
}

/** Knopf „Widget ausblenden/einblenden“: nur sichtbar, wenn ein Timer laeuft oder der Fokus-Modus offen ist */
function paintWidgetBtn() {
  const b = q<HTMLButtonElement>(".wbtn");
  const hidden = widgetHidden();
  b.hidden = !(focus?.pomo.active || isFocus());
  b.classList.toggle("off", hidden);
  b.setAttribute("aria-pressed", String(hidden));
  b.title = hidden ? "Pomodoro-Widget einblenden" : "Pomodoro-Widget ausblenden";
  b.setAttribute("aria-label", b.title);
  b.replaceChildren(ico(hidden ? "eye-off" : "eye"));
}

/** Anmeldebild: Formular oder Fortschritt des ersten Abgleichs */
function working(on: boolean) {
  const card = q(".lg-card");
  card.classList.toggle("working", on);
  card.querySelector("form")!.hidden = on;
  card.querySelector<HTMLElement>(".sp")!.hidden = !on;
  card.querySelector(".lg-brand span")!.textContent = on ? "Einen Moment, ich richte alles ein" : "mit LearnWeb anmelden";
}

/** Nach der Anmeldung: gibt es schon Kurse, geht es gleich weiter; sonst sucht und ordnet Kursbuch zuerst alles ein */
async function freshLogin() {
  const o = await api.overview().catch(() => null);
  if (o?.status === "ok" && o.courses.length) { void account.refresh(); return; }
  autoTried = true;
  working(true);
  void sync.start();
}

/** Beim Start (und nach der Anmeldung) einmal abgleichen, wenn noch nichts da oder der Stand alt ist */
let autoTried = false;
async function autoSync() {
  if (autoTried) return;
  autoTried = true;
  const o = await api.overview().catch(() => null);
  const stale = o?.status === "no_state" || (o?.status === "ok" && (!o.last_run || Date.now() / 1000 - o.last_run > STALE_H * 3600));
  if (stale && !isLocked()) void sync.start();
}

function syncEnded(ok: boolean, st: { error: string | null; code: string | null }) {
  signature = "";
  const first = q(".lg-card").classList.contains("working");
  if (first && ok) { working(false); void account.refresh(); return; } // erster Abgleich fertig: Anmeldebild weicht der Ansicht
  if (!ok && (st.code === "login" || st.code === "credentials")) { // Zugangsdaten stimmen nicht mehr: zurueck zur Anmeldung
    working(false);
    toast(st.error ?? "Die Anmeldung bei LearnWeb ist fehlgeschlagen.");
    void account.refresh();
    return;
  }
  if (first) return; // Fehler: die Karte zeigt ihn und bietet „Nochmal“ an
  void refresh();
  if (!ok) toast(st.error ?? "Der Abgleich mit LearnWeb ist fehlgeschlagen.");
}

/** Zugangsdaten gespeichert oder nicht: Anmeldebild bzw. die Ansicht. Beim Abmelden endet auch ein laufender Timer. */
function loginState(saved: boolean) {
  try { localStorage.setItem(KEY_LOGIN, saved ? "1" : "0"); } catch { /* egal */ }
  if (!saved && focus?.pomo.active) focus.pomo.stop();
  setLocked(!saved);
  if (saved) { void refresh(); void autoSync(); }
  scenesChanged();
}

function renderAll() {
  tl.setEvents(events);
  tt.setEvents(events);
  abgaben.render(events);
  tl.refresh();
}

/** Stand von Rust holen; nur bei Aenderung neu zeichnen (das Fenster bekommt oft den Fokus, die Ansicht bleibt dabei stehen) */
async function refresh() {
  const o = await api.overview().catch((e): Overview => ({ status: "error", error: typeof e === "string" ? e : "Der Stand von LearnWeb lässt sich nicht lesen.", last_run: null, courses: [] }));
  const [ev, nw] = await Promise.all([api.events().catch(() => [] as Ev[]), api.news().catch(() => [] as NewItem[])]);
  const sug = await api.scheduleGet().catch(() => []);
  const sig = JSON.stringify([o, ev, nw, sug]);
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
  tt.setSuggestions(sug);
  clay?.refresh(); // ein offener Kurs zeigt auch neue Daten (nach dem Sync)
}

async function go(l: Link) {
  if (l.view === "kurs") { if (!isLocked()) void clay.open(l.arg); }
  else if (l.view === "suche") search.open(l.arg);
  else if (l.view === "fokus") { if (!isLocked()) setFocus(true); scenesChanged(); }
  else if (l.view === "heute") {
    tl.today();
    tt.pick(todayDay());
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
  clay = new CourseLayer();
  const open = (id: number, target: CourseTarget = {}) => { if (!isLocked()) void clay.open(id, target); };
  const nextOf = (id: number) => events.filter((e) => e.course === id && e.ts >= Date.now() / 1000 - 3600).sort((a, b) => a.ts - b.ts)[0];

  // gemerkter Stand: wer zuletzt angemeldet war, sieht sofort die Ansicht (die Pruefung folgt im Hintergrund)
  let cached = false;
  try { cached = localStorage.getItem(KEY_LOGIN) === "1"; } catch { /* egal */ }
  if (!cached) document.body.classList.add("locked");
  account = new Account({ onChange: () => { signature = ""; void refresh(); }, onStatus: loginState });
  q("#acct-host").replaceWith(account.el);
  courses = new Courses({
    onOpen: open,
    onRead: () => void refresh(),
    // Kurse lassen sich auf Stundenplan-Eintraege ziehen (drag.ts); der Plan entsteht etwas spaeter, daher erst beim Aufruf nachsehen
    drag: { over: (x, y, c) => tt.dropOver(x, y, c), rect: () => tt.dropRect(), assign: (c) => tt.dropAssign(c), clear: () => tt.dropClear(), scroller: () => tt.scroller },
  });
  tl = new Timeline({ hueOf, nameOf, onOpen: open });
  abgaben = new Abgaben({ hueOf, nameOf, onOpen: open });
  tt = new Timetable({
    semester: () => courses.semester,
    courses: () => courses.inSemester(),
    card: (id) => courses.card(id),
    nextOf,
    newOf: courses.newOf,
    openCourse: open,
    openWeb: (id) => act(api.openWeb(id)),
    onPick: (day) => tl.focusDay(day),
  });
  search = new Search({
    hueOf, nameOf,
    semesterIds: () => courses.semesterIds(),
    semesterLabel: () => (courses.semester ? shortSem(courses.semester) : ""),
    reveal: async (id, target) => { open(id, target ?? {}); },
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
  sync = new SyncUi(syncEnded);
  card.append(brand, loginForm(() => void freshLogin()), sync.card(() => void sync.start(), () => { working(false); void account.refresh(); }));
  card.querySelector<HTMLElement>(".sp")!.hidden = true;
  lg.append(card);
  // der Timer laeuft in einem eigenen Widget-Fenster ohne Rahmen (immer oben); die gemerkte Lage geht mit
  focus = new FocusScene((on) => { setWidget(on && !widgetHidden()); paintWidgetBtn(); });
  let lastPhase = "";
  focus.pomo.subscribe(() => { // Farbe des Nebels folgt der Phase des Timers
    const k = focus.pomo.status === "idle" ? "idle" : focus.pomo.phase;
    if (k !== lastPhase) { lastPhase = k; tint(); paintWidgetBtn(); }
  });
  void listen<string>("pomodoro-action", (e) => { if (e.payload === "hide") toggleWidget(true); }); // der kleine Knopf im Widget selbst
  lg.dataset.tauriDragRegion = "";
  q("#scene").append(lg, focus.el);
  initGrab(q(".sheet"), q(".grab"), scenesChanged);
  q(".fbtn").addEventListener("click", () => { setFocus(!isFocus()); scenesChanged(); });
  q(".wbtn").addEventListener("click", () => toggleWidget());
  sync.bind(q(".syncbtn"));
  paintWidgetBtn();
  q(".bgbtn").addEventListener("click", () => applyBg(document.documentElement.dataset.bg !== "beige"));
  let beige = false;
  try { beige = localStorage.getItem(KEY_BG) === "beige"; } catch { /* egal */ }
  applyBg(beige);
  void document.fonts?.ready.then(() => tl.refresh()); // der Zeitstrahl zeichnet mit der Schrift

  q("#tl-host").append(tl.el);
  q("#slot-l").append(courses.el);
  q("#slot-c").append(tt.el);
  q("#slot-r").append(abgaben.el);

  glassLight();
  liquid();
  segments(document, ".n-seg");
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  // Abgaben als Schublade in schmalen Fenstern
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
    if (e.key === "Escape") { if (clay.isOpen) clay.close(); else if (document.body.classList.contains("dr")) closeDrawer(); else if (isFocus()) { setFocus(false); scenesChanged(); } else if (document.body.classList.contains("full")) void setFull(false); }
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
  window.addEventListener("focus", () => { void refresh(); clay.refresh(); });
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
