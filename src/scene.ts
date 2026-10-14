/**
 * Szenen des Hauptfensters (Klassen am body):
 * - `locked`: Anmeldebild. Nur der farbige Verlauf und ein Liquid-Glass-Anmeldefeld; die dunkle Flaeche ist unten. Nach der
 *   Anmeldung faehrt sie von unten hoch und ihre Teile gleiten nach.
 * - (keine Klasse): die gewohnte Ansicht mit der dunklen Flaeche.
 * - `focus`: die Flaeche ist heruntergefahren (bis auf einen Streifen mit dem Griff); darauf liegen Verlauf, To-dos, Timer, Streak.
 * - `pomo`: der Pomodoro-Timer steht allein; Leiste, Fensterknoepfe, Suche, alles andere ist weg, das Fenster darf beliebig
 *   klein werden. Die Fensterknoepfe kommen mit dem Ende des Timers zurueck.
 */

import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

const body = document.body;
const NORMAL_MIN = new LogicalSize(760, 520);
const ALONE_MIN = new LogicalSize(170, 150);
const PEEK = 46;

export const isLocked = () => body.classList.contains("locked");
export const isFocus = () => body.classList.contains("focus");
export const isAlone = () => body.classList.contains("pomo");

export function setLocked(on: boolean) {
  if (on === isLocked()) return;
  body.classList.toggle("locked", on);
  if (on) { body.classList.remove("focus", "pomo"); return; }
  // die Flaeche faehrt hoch, ihre Teile gleiten nacheinander nach
  body.classList.add("rising");
  window.setTimeout(() => body.classList.remove("rising"), 1800);
}

export function setFocus(on: boolean) {
  if (isLocked() || isAlone()) return;
  body.classList.toggle("focus", on);
}

/** Timer allein: Fenster nach vorn, beliebig klein; beim Verlassen wieder die gewohnte Mindestgroesse */
export async function setAlone(on: boolean) {
  if (on === isAlone()) return;
  body.classList.toggle("pomo", on);
  const win = getCurrentWindow();
  try {
    if (on) {
      await win.setMinSize(ALONE_MIN);
      await win.unminimize();
      await win.show();
      await win.setFocus();
    } else {
      await win.setMinSize(NORMAL_MIN);
      const f = await win.scaleFactor();
      const s = await win.innerSize();
      const w = s.width / f, h = s.height / f;
      if (w < NORMAL_MIN.width || h < NORMAL_MIN.height) await win.setSize(new LogicalSize(Math.max(w, NORMAL_MIN.width), Math.max(h, NORMAL_MIN.height)));
    }
  } catch { /* ohne Fensterrechte bleibt es bei der Ansicht */ }
}

/** Griff am oberen Rand der Flaeche: Klick oder Ziehen nach unten faehrt sie herunter, im Fokus-Modus Klick oder Ziehen nach oben wieder hoch */
export function initGrab(sheet: HTMLElement, grab: HTMLElement, changed: () => void) {
  let y0 = 0, active = false, moved = false;
  grab.addEventListener("pointerdown", (e) => {
    active = true; moved = false; y0 = e.clientY;
    grab.setPointerCapture(e.pointerId);
    sheet.style.transition = "none";
  });
  grab.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dy = e.clientY - y0;
    if (Math.abs(dy) > 4) moved = true;
    const max = sheet.offsetHeight - PEEK;
    sheet.style.transform = `translateY(${Math.min(max, Math.max(0, (isFocus() ? max : 0) + dy))}px)`;
  });
  const end = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    const dy = e.clientY - y0;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (!moved) setFocus(!isFocus());
    else if (!isFocus() && dy > 80) setFocus(true);
    else if (isFocus() && dy < -80) setFocus(false);
    changed();
  };
  grab.addEventListener("pointerup", end);
  grab.addEventListener("pointercancel", end);
  grab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFocus(!isFocus()); changed(); } });
}
