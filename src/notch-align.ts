// Ausrichtung an der Notch (Vorbild: Arena, src/notch-align.ts): Kursbuch fragt Rust (notch.rs notch_rect), wo die Notch
// auf dem Bildschirm sitzt, und haelt die Flaeche frei, die sie verdeckt. Oben angedockt: die Kopfleiste teilt sich in
// links und rechts der Notch (die Luecke steht unter ihr). Seitlich angedockt: Kopf, Zeitstrahl und Inhalt halten Abstand.
// Laeuft keine Notch (oder liegt sie nicht ueber dem Fenster), bleibt alles wie gewohnt. Die aufgeklappte Notch ist
// voruebergehend groesser und darf den Inhalt kurz ueberdecken.

import { api, type NotchRect } from "./api";

const MARGIN = 12;

/** Der Teil der Notch, der ins Fenster ragt, als Kopf-Luecke: Beginn und Breite in Fensterpixeln, sonst null */
export function headGap(r: NotchRect | null, headHeight: number, width: number) {
  if (!r || r.dock !== "top") return null;
  if (r.y + r.h <= 0 || r.y >= headHeight) return null; // liegt nicht ueber der Kopfleiste
  const x = Math.max(0, r.x - MARGIN);
  const end = Math.min(width, r.x + r.w + MARGIN);
  return end - x > 40 && x < width - 40 ? { x, w: end - x } : null;
}

/** Seitlicher Abstand fuer links bzw. rechts angedockte Notch */
export function sideGap(r: NotchRect | null, width: number, height: number) {
  if (!r || r.dock === "top" || r.y >= height || r.y + r.h <= 0) return { l: 0, r: 0 };
  const l = r.dock === "left" ? Math.max(0, r.x + r.w) : 0;
  const rt = r.dock === "right" ? Math.max(0, width - r.x) : 0;
  return { l: l > 0 && l < 200 ? l + MARGIN : 0, r: rt > 0 && rt < 200 ? rt + MARGIN : 0 };
}

let rect: NotchRect | null = null;
let timer = 0;

export function applyNotch() {
  const root = document.documentElement;
  const head = document.querySelector<HTMLElement>(".top")?.offsetHeight ?? 52;
  const gap = headGap(rect, head, innerWidth);
  document.body.classList.toggle("notched", !!gap);
  root.style.setProperty("--nz-x", gap ? `${gap.x}px` : "0px");
  root.style.setProperty("--nz-w", gap ? `${gap.w}px` : "0px");
  const s = sideGap(rect, innerWidth, innerHeight);
  root.style.setProperty("--notch-l", `${s.l}px`);
  root.style.setProperty("--notch-r", `${s.r}px`);
}

/** Lage neu holen (Fenster verschoben oder in der Groesse veraendert, Notch umgedockt oder gestartet) */
export async function refreshNotch() {
  rect = await api.notchRect().catch(() => null);
  applyNotch();
}

/** Lage beim Start, nach Verschieben/Groesse (entprellt) und alle paar Sekunden (Umdocken, Notch startet oder endet) */
export function watchNotch(onMove: ((cb: () => void) => void)[] = []) {
  const later = () => { clearTimeout(timer); timer = window.setTimeout(() => void refreshNotch(), 120); };
  addEventListener("resize", () => { applyNotch(); later(); });
  onMove.forEach((reg) => reg(later));
  void refreshNotch();
  window.setInterval(() => void refreshNotch(), 4000);
}
