/**
 * Kursbuch — LearnWeb im Nojo-Oekosystem, ein Dashboard ueber die ganze Fensterbreite:
 * Zeitstrahl oben (Fischauge, scrollbar), links Kalender, in der Mitte die Kurse des gewaehlten Semesters (Chips zum
 * schnellen Wechsel, geoeffnete Kurse als fortlaufende Seiten nebeneinander), rechts Fristen und Neues. Die Notch
 * bekommt ihre Zone im Kopf frei (notch-align.ts). Daten sind lokal (Python-Seite); Deep Link kursbuch://heute | kurs/<id>.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, liquid, segments, windowControls } from "./nojo/nojo-ui";
import { api, type Ev, type Link, type NewItem, type Overview } from "./api";
import { Agenda } from "./agenda";
import { Calendar } from "./calendar";
import { Courses } from "./courses";
import { dayOfTs, todayDay } from "./dates";
import { Fog } from "./fog";
import { applyNotch, watchNotch } from "./notch-align";
import { Side } from "./side";
import { Timeline } from "./timeline";
import { el, fillIcons, hueHex, ico, q, shortSem, toast } from "./ui";

let events: Ev[] = [];
let news: NewItem[] = [];
let signature = "";
let fog: Fog;
let tl: Timeline;
let cal: Calendar;
let agenda: Agenda;
let side: Side;
let courses: Courses;

const pad = (n: number) => String(n).padStart(2, "0");

/** „heute 13:40“, „gestern 07:15“, „12.10. 07:15“ */
function when(unix: number) {
  const d = new Date(unix * 1000);
  const days = todayDay() - dayOfTs(unix);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return days === 0 ? `heute ${t}` : days === 1 ? `gestern ${t}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${t}`;
}

function renderSync(o: Overview) {
  const s = q(".sync");
  const age = o.last_run ? Date.now() / 1000 - o.last_run : Infinity;
  s.classList.toggle("ok", age < 36 * 3600);
  s.classList.toggle("wait", age >= 36 * 3600);
  q(".sync-t").textContent = o.last_run ? when(o.last_run) : "–";
  s.title = o.last_run ? `Letzter Sync: ${when(o.last_run)}` : "Noch kein Sync";
}

/** Semester-Segmente im Kopf (kurze Namen, „Weitere“ als Symbol) */
function renderSems() {
  const nav = q(".sems");
  const list = courses.semesters();
  nav.hidden = list.length < 2;
  nav.replaceChildren(...list.map((s) => {
    const b = el("button", s === courses.semester ? "active" : "");
    b.setAttribute("aria-pressed", String(s === courses.semester));
    b.title = s;
    if (s === "Weitere") b.append(ico("more")); else b.textContent = shortSem(s);
    b.addEventListener("click", () => courses.setSemester(s));
    return b;
  }));
}

/** Nebel in den Farben der geoeffneten Kurse (sonst des Semesters) */
function tint() {
  const { base, open } = courses.hues();
  fog.setColors(base.map((h) => hueHex(h)), open.map((h) => hueHex(h)));
}

function renderAll() {
  tl.setEvents(events);
  cal.setEvents(events);
  agenda.render(events);
  side.render(events, news);
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
  renderSync(o);
  courses.setOverview(o);
  renderSems();
  renderAll();
  tint();
}

async function go(l: Link) {
  if (l.view === "kurs") { if (!(await courses.open(l.arg))) toast("Kurs nicht gefunden"); }
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
  const open = (id: number) => void courses.open(id);
  courses = new Courses({
    nextOf: (id) => events.filter((e) => e.course === id && e.ts >= Date.now() / 1000 - 3600).sort((a, b) => a.ts - b.ts)[0],
    onChange: () => { renderSems(); tint(); },
  });
  tl = new Timeline({ hueOf, nameOf, onOpen: open });
  cal = new Calendar({ hueOf, nameOf, onOpen: open, onPick: (day) => tl.focusDay(day) });
  agenda = new Agenda({ hueOf, nameOf, onOpen: open });
  side = new Side({ hueOf, nameOf, onOpen: open, onRead: () => void refresh() });
  q("#tl-host").append(tl.el);
  q("#slot-l").append(cal.el, agenda.el);
  q("#slot-c").append(courses.el);
  q("#slot-r").append(side.el);

  glassLight();
  liquid();
  segments(document, ".n-seg");
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  // Seitenleisten als Schubladen in kleinen Fenstern
  const scrim = q(".scrim");
  const closeDrawers = () => { document.body.classList.remove("dl", "dr"); scrim.hidden = true; };
  document.querySelectorAll<HTMLButtonElement>(".drawer").forEach((b) => b.addEventListener("click", () => {
    const cls = b.dataset.drawer!;
    const on = !document.body.classList.contains(cls);
    closeDrawers();
    document.body.classList.toggle(cls, on);
    scrim.hidden = !on;
  }));
  scrim.addEventListener("click", closeDrawers);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (document.body.classList.contains("dl") || document.body.classList.contains("dr")) closeDrawers(); else if (document.body.classList.contains("full")) void setFull(false); }
    if (e.key === "F11") { e.preventDefault(); void setFull(!document.body.classList.contains("full")); }
  });

  watchNotch([(cb) => void win.onResized(cb).catch(() => {}), (cb) => void win.onMoved(cb).catch(() => {})]);
  await refresh();
  applyNotch();

  await listen<Link>("open-link", (e) => { void api.takePending(); void go(e.payload); });
  const pending = await api.takePending().catch(() => null);
  if (pending) await go(pending);
  window.addEventListener("focus", () => void refresh());
  // Restzeiten und „heute“ nachziehen
  window.setInterval(() => { side.render(events, news); agenda.render(events); tl.refresh(); }, 60_000);
}

void main();
