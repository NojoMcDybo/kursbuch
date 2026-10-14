/**
 * Kursfenster (`index.html?kurs=<id>`, geoeffnet von Rust: windows.rs): oben der Kurs als Titelleiste mit Fensterknoepfen, darunter
 * die Seite des Kurses auf einer Flaeche mit runden oberen Ecken wie im Hauptfenster. Ein zweiter Klick auf denselben Kurs
 * schickt „reveal“ (Aktivitaet oder Abschnitt zeigen). Das Design der Kursseite wird spaeter noch einmal besprochen.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, liquid, windowControls } from "./nojo/nojo-ui";
import { CoursePage, type Target } from "./coursepage";
import { Fog } from "./fog";
import { el, hueHex, toast } from "./ui";

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

  const fog = new Fog();
  document.body.prepend(fog.el);
  const dot = el("i", "cw-dot");
  const title = el("h1", "cw-title");
  const sub = el("span", "cw-sub");
  const top = el("header", "top");
  top.dataset.tauriDragRegion = "";
  const lead = el("div", "cw-lead");
  lead.dataset.tauriDragRegion = "";
  lead.append(dot, title, sub);
  top.append(lead);

  const page = new CoursePage(id, (v) => {
    title.textContent = v.title;
    sub.textContent = [v.teacher, v.semester].filter(Boolean).join(" · ");
    dot.style.setProperty("--h", String(v.hue));
    document.title = v.title;
    fog.setColors([hueHex(v.hue)]);
  });
  const sheet = el("main", "sheet cw");
  sheet.append(page.el);
  document.body.append(top, sheet);
  glassLight();
  liquid();
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  if (!(await page.load())) {
    title.textContent = "Kurs nicht gefunden";
    toast("Kurs nicht gefunden");
    return;
  }
  if (target.cmid != null || target.section) window.setTimeout(() => page.reveal(target), 400);
  await listen<Target>("reveal", (e) => page.reveal(e.payload));
  window.addEventListener("focus", () => void page.load());
  document.addEventListener("keydown", (e) => { if (e.key === "F11") { e.preventDefault(); void win.setFullscreen(!full()).then(syncWindow); } });
}
