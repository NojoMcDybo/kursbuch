/** Kleine Hilfen fuer die Oberflaeche */

import { iconNode, type IconName } from "./nojo/nojo-ui";

export const q = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Symbol aus der Nojo-Bibliothek als Element */
export const ico = (name: IconName, size?: number) => iconNode(name, size ? { size } : {});

/** Platzhalter <i data-icon="…"> im HTML durch das Symbol ersetzen */
export function fillIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((p) => {
    const svg = ico(p.dataset.icon as IconName);
    svg.classList.add(...p.classList);
    p.replaceWith(svg);
  });
}

export const announce = (t: string) => { q(".sr").textContent = t; };

let toastTimer = 0;
/** Kurze Meldung unten (Fehler beim Oeffnen u. ae.) */
export function toast(msg: string) {
  const t = q(".toast");
  t.textContent = msg;
  t.hidden = false;
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 4500);
}

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Unbekannter Fehler.");

/** Aktion starten; Fehler als Meldung zeigen */
export function act(p: Promise<unknown>) {
  p.catch((e) => toast(message(e)));
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
