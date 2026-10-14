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

/** Symbolknopf (nur Symbol, Hinweis als Tooltip und fuer Screenreader) */
export function iconBtn(name: IconName, title: string, cls = "n-ico sm", run?: () => void) {
  const b = el("button", cls);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(ico(name));
  if (run) b.addEventListener("click", run);
  return b;
}

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

/** Farbe eines Kurses aus seinem Farbton (gleiche Formel wie die Notch-Karte in Rust: hsl(Ton 68% 62%)) */
export const hsl = (hue: number, a = 1, l = 62) => `hsl(${hue} 68% ${l}% / ${a})`;

/** Hex-Farbe zu einem Farbton (fuer den Nebel) */
export function hueHex(hue: number, s = 0.74, l = 0.56) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue / 60) % 6];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

/** „WiSe 2026/27“ -> „WiSe 26/27“, „SoSe 2026“ -> „SoSe 26“ */
export const shortSem = (s: string) => s.replace(/(\d{2})(\d{2})/g, "$2");
