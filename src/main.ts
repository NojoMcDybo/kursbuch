/**
 * Kursbuch — LearnWeb-Kurse, Fristen und Suche.
 *
 * - Heute:  Fristen und Neues (Phase 3, bisher Huelle)
 * - Kurse:  Raster nach Semester, darin die Kursansicht (kurse.ts)
 * - Suche:  Volltext (Phase 3, bisher Huelle); Strg+K springt hierher
 * Die App liest nur lokale Daten (Stand der Python-Seite). Deep Link kursbuch://heute | kurs/<id> | suche/<Begriff>.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, lightScroller, liquid, segments, windowControls } from "./nojo/nojo-ui";
import { api, type Link, type Overview } from "./api";
import { initCourses, openCourse, renderCourses, showGrid } from "./kurse";
import { fillIcons, q } from "./ui";

type View = "heute" | "kurse" | "suche";
const VIEWS: View[] = ["heute", "kurse", "suche"];
let view: View = "kurse";
let signature = "";

function setView(v: View) {
  if (v === "kurse" && view === "kurse") showGrid(); // Reiter nochmal antippen = zurueck zum Raster
  view = v;
  document.querySelectorAll<HTMLElement>(".view").forEach((s) => { s.hidden = s.dataset.view !== v; });
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  q("#main").scrollTop = 0;
  try { localStorage.setItem("kursbuch-view", v); } catch { /* egal */ }
  if (v === "suche") q<HTMLInputElement>(".search").focus();
}

function go(l: Link) {
  if (l.view === "heute") setView("heute");
  else if (l.view === "suche") { setView("suche"); q<HTMLInputElement>(".search").value = l.arg; }
  else { setView("kurse"); void openCourse(l.arg); }
}

// ---------- Stand ----------

const pad = (n: number) => String(n).padStart(2, "0");
/** „heute 13:40“, „gestern 07:15“, „12.10. 07:15“ */
function when(unix: number) {
  const d = new Date(unix * 1000), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return days === 0 ? `heute ${t}` : days === 1 ? `gestern ${t}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${t}`;
}

function renderSync(o: Overview) {
  const s = q(".sync");
  const age = o.last_run ? Date.now() / 1000 - o.last_run : Infinity;
  s.classList.toggle("ok", age < 36 * 3600);
  s.classList.toggle("wait", age >= 36 * 3600);
  q(".sync-t").textContent = o.last_run ? when(o.last_run) : "kein Sync";
  s.title = o.last_run ? `Letzter Sync: ${when(o.last_run)}` : "Noch kein Sync gelaufen";
}

/** Stand von Rust holen; nur bei Aenderung neu zeichnen (Fenster bekommt oft den Fokus, die Ansicht soll dabei stehen bleiben) */
async function refresh() {
  const o = await api.overview().catch((e): Overview => ({ status: "error", error: typeof e === "string" ? e : "Der Stand von LearnWeb lässt sich nicht lesen.", last_run: null, courses: [] }));
  const sig = JSON.stringify(o);
  if (sig === signature) return;
  signature = sig;
  renderSync(o);
  renderCourses(o);
}

// ---------- Start ----------

async function main() {
  fillIcons();
  const win = getCurrentWindow();
  const syncWindow = async () => document.body.classList.toggle("max", !!(await win.isMaximized().catch(() => false)));
  windowControls({
    minimize: () => void win.minimize().catch(() => {}),
    toggleMaximize: () => void win.toggleMaximize().catch(() => {}),
    close: () => void win.close().catch(() => {}),
  });
  glassLight();
  liquid();
  segments(document, ".n-seg");
  lightScroller(q("main"), { insetTop: 74 });
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  initCourses(q('.view[data-view="kurse"]'));
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view as View)));
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === "k") { e.preventDefault(); setView("suche"); }
    else if (/^[1-3]$/.test(e.key)) { e.preventDefault(); setView(VIEWS[Number(e.key) - 1]); }
  });
  q(".day").textContent = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });

  let start: View = "kurse";
  try { const s = localStorage.getItem("kursbuch-view"); if (VIEWS.includes(s as View)) start = s as View; } catch { /* egal */ }
  setView(start);
  await refresh();

  // Deep Link: laufende App (Ereignis) und Start mit Link (abholen)
  await listen<Link>("open-link", (e) => { void api.takePending(); go(e.payload); });
  const pending = await api.takePending().catch(() => null);
  if (pending) go(pending);
  window.addEventListener("focus", () => void refresh());
}

void main();
