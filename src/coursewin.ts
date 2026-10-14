/**
 * Kursfenster (`index.html?kurs=<id>`, geoeffnet von Rust: windows.rs, maximiert): ohne Leiste, die Seite des Kurses fuellt das ganze
 * Fenster; die Fensterpille (Minimieren, Maximieren, Schliessen) schwebt oben rechts. Ein zweiter Klick auf denselben Kurs
 * schickt „reveal“ (Aktivitaet oder Abschnitt zeigen). Das Design der Kursseite wird spaeter noch einmal besprochen.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, liquid, windowControls } from "./nojo/nojo-ui";
import { CoursePage, type Target } from "./coursepage";
import { el, toast } from "./ui";

export async function mountCourseWindow(id: number, target: Target) {
  document.body.classList.add("cwin");
  const win = getCurrentWindow();
  const full = () => document.body.classList.contains("full");
  const syncWindow = async () => {
    const [max, fs] = await Promise.all([win.isMaximized().catch(() => false), win.isFullscreen().catch(() => false)]);
    document.body.classList.toggle("max", !!max);
    document.body.classList.toggle("full", !!fs);
  };
  windowControls({
    minimize: () => void win.minimize().catch(() => {}),
    toggleMaximize: () => void (full() ? win.setFullscreen(false) : win.toggleMaximize()).catch(() => {}),
    close: () => void win.close().catch(() => {}),
  });

  // keine Leiste: die Kursseite fuellt das ganze Fenster; Titel und Aktionen stehen in ihrem Kopf, die Fensterpille schwebt darueber
  const page = new CoursePage(id, (v) => { document.title = v.title; });
  const sheet = el("main", "sheet cw");
  sheet.append(page.el);
  document.body.append(sheet);
  glassLight();
  liquid();
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  if (!(await page.load())) {
    toast("Kurs nicht gefunden");
    return;
  }
  if (target.cmid != null || target.section) window.setTimeout(() => page.reveal(target), 400);
  await listen<Target>("reveal", (e) => page.reveal(e.payload));
  window.addEventListener("focus", () => void page.load());
  document.addEventListener("keydown", (e) => { if (e.key === "F11") { e.preventDefault(); void win.setFullscreen(!full()).then(syncWindow); } });
}
