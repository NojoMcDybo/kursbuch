/**
 * Kurse per Ziehen einem Eintrag im Stundenplan zuordnen. Die Zeile in der Kursliste hebt sich ab und folgt dem Zeiger als kleine Karte
 * in der Kursfarbe; Eintraege ohne Kurs pulsieren leicht (dort passt sie hin), der Eintrag unter dem Zeiger leuchtet in der Kursfarbe.
 * Loslassen auf einem Eintrag: die Karte fliegt hinein und schrumpft, der Eintrag nimmt die Farbe an. Sonst federt sie zur Zeile zurueck.
 * Esc bricht ab. Ein Klick ohne Ziehen oeffnet weiter den Kurs (erst ab 6 Pixeln Bewegung beginnt das Ziehen).
 * Zeigerereignisse statt HTML-Drag-and-drop: Tauri faengt das fuer Dateien ab, und so laesst sich die Bewegung selbst gestalten.
 */

import type { CourseCard } from "./api";
import { el, hsl } from "./ui";

export type DropTarget = {
  /** Eintrag unter dem Zeiger hervorheben; true, wenn dort etwas zuzuordnen ist */
  over: (x: number, y: number, c: CourseCard) => boolean;
  /** Rechteck des hervorgehobenen Eintrags (fuer die Landung) oder null */
  rect: () => DOMRect | null;
  /** loslassen auf dem hervorgehobenen Eintrag: zuordnen */
  assign: (c: CourseCard) => void;
  /** Hervorhebung aufheben */
  clear: () => void;
  /** Bildlauf des Plans (Ziehen an den Rand blaettert) */
  scroller: () => HTMLElement;
};

const START = 6; // Pixel, ab denen aus einem Klick ein Ziehen wird
const EDGE = 44; // Abstand zum Rand des Plans, ab dem er blaettert
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPRING = "cubic-bezier(0.22, 1.12, 0.36, 1)";

export function makeDraggable(row: HTMLElement, c: CourseCard, t: DropTarget) {
  row.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || down.pointerType === "touch") return;
    const r0 = row.getBoundingClientRect();
    const grab = { x: down.clientX - r0.left, y: down.clientY - r0.top };
    let ghost: HTMLElement | null = null;
    let pos = { x: down.clientX, y: down.clientY };
    let scroll = 0; // Richtung des Randblaetterns
    let timer = 0;

    const place = () => ghost?.style.setProperty("translate", `${pos.x - grab.x}px ${pos.y - grab.y}px`);
    const probe = () => ghost?.classList.toggle("over", t.over(pos.x, pos.y, c));

    const start = () => {
      ghost = el("div", "drag-ghost");
      ghost.style.setProperty("--c", hsl(c.hue));
      ghost.style.width = `${r0.width}px`;
      ghost.append(el("i", "cl-dot"), el("span", "cl-t", c.title));
      place();
      document.body.append(ghost);
      document.body.classList.add("dragging-course");
      row.classList.add("lifted");
      requestAnimationFrame(() => ghost?.classList.add("on")); // hebt sich ab (Transition auf scale/rotate)
      timer = window.setInterval(() => {
        if (scroll) { t.scroller().scrollTop += scroll; probe(); }
      }, 16);
    };

    const move = (e: PointerEvent) => {
      pos = { x: e.clientX, y: e.clientY };
      if (!ghost) {
        if (Math.hypot(pos.x - down.clientX, pos.y - down.clientY) < START) return;
        start();
      }
      place();
      probe();
      const r = t.scroller().getBoundingClientRect();
      const inside = pos.x >= r.left && pos.x <= r.right;
      scroll = inside && pos.y < r.top + EDGE && pos.y > r.top - EDGE ? -10 : inside && pos.y > r.bottom - EDGE && pos.y < r.bottom + EDGE ? 10 : 0;
    };

    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.clearInterval(timer);
      document.body.classList.remove("dragging-course");
      row.classList.remove("lifted");
    };

    /** Das Loslassen soll die Zeile nicht anklicken (der Klick folgt nur, wenn Beginn und Ende dieselbe Zeile treffen) */
    const noClick = () => {
      const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener("click", stop, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", stop, true), 80);
    };

    const back = (g: HTMLElement) => {
      const now = g.style.getPropertyValue("translate");
      const done = () => g.remove();
      if (reduced()) return done();
      g.classList.remove("on", "over");
      g.animate([{ translate: now, scale: 1.05, rotate: "-2deg" }, { translate: `${r0.left}px ${r0.top}px`, scale: 1, rotate: "0deg" }], { duration: 300, easing: SPRING }).finished.then(done, done);
    };

    const up = () => {
      const g = ghost;
      finish();
      if (!g) return; // nur ein Klick
      noClick();
      const target = t.rect();
      if (!target) { t.clear(); return back(g); }
      // Landung: die Karte fliegt in die Mitte des Eintrags und schrumpft; der Eintrag nimmt die Farbe an
      const x = target.left + target.width / 2 - r0.width / 2, y = target.top + target.height / 2 - r0.height / 2;
      t.assign(c);
      const done = () => g.remove();
      if (reduced()) return done();
      g.classList.remove("on", "over");
      g.animate([{ translate: g.style.getPropertyValue("translate"), scale: 0.94, opacity: 1 }, { translate: `${x}px ${y}px`, scale: 0.2, opacity: 0 }], { duration: 380, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" }).finished.then(done, done);
    };

    const cancel = () => {
      const g = ghost;
      finish();
      t.clear();
      if (g) { noClick(); back(g); }
    };

    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && ghost) { e.stopPropagation(); cancel(); } };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  });
}
