/** Kleine Hilfen fuer die Oberflaeche */

import { iconNode, type IconName } from "./nojo/nojo-ui";

const TYPE_ICON: Record<string, IconName> = {
  resource: "document", folder: "folder", url: "link", forum: "forum", assign: "abgabe", opencast: "video", zoom: "video",
  scheduler: "kalender", h5pactivity: "pointer", data: "layout", ratingallocate: "check", feedback: "check",
};
/** Symbol zur Art einer Aktivitaet in LearnWeb */
export const typeIcon = (t: string): IconName => TYPE_ICON[t] ?? "open";

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
/** Kurze Meldung unten (Fehler beim Oeffnen u. ae.); mit `action` ein Knopf dazu (z. B. „Trotzdem laden“) */
export function toast(msg: string, action?: { label: string; run: () => void }) {
  const t = q(".toast");
  t.replaceChildren(msg);
  if (action) {
    const b = el("button", "toast-a", action.label);
    b.addEventListener("click", () => { t.hidden = true; action.run(); });
    t.append(b);
  }
  t.hidden = false;
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, action ? 9000 : 4500);
}

/** Text einer Fehlermeldung aus Rust (String oder { message }) */
export const message = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : "Unbekannter Fehler.";

/** Aktion starten; Fehler als Meldung zeigen */
export function act(p: Promise<unknown>) {
  p.catch((e) => toast(message(e)));
}

/** In die Zwischenablage (Rueckfall ueber ein verstecktes Feld, falls die Schnittstelle fehlt oder abgelehnt wird) */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (!ok) throw new Error("Die Zwischenablage ist nicht erreichbar.");
  }
}

/** 12400 -> „12.400“ */
export const num = (n: number) => n.toLocaleString("de-DE");

export type MenuItem = { icon: IconName; label: string; hint?: string; run: () => void };

/** Kleines Glasmenue unter einem Knopf; schliesst bei Klick daneben, Esc oder Auswahl */
export function menu(anchor: HTMLElement, items: MenuItem[]) {
  document.querySelector(".menu")?.remove();
  const m = el("div", "menu n-glass n-liquid panel");
  m.setAttribute("role", "menu");
  const close = () => { m.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  const away = (e: Event) => { if (!m.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  for (const it of items) {
    const b = el("button", "menu-i");
    b.setAttribute("role", "menuitem");
    b.append(ico(it.icon), el("span", "", it.label));
    if (it.hint) b.append(el("small", "", it.hint));
    b.addEventListener("click", () => { close(); it.run(); });
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`;
  m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", key, true);
  m.querySelector<HTMLElement>("button")?.focus();
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

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eine Flaeche waechst aus dem Rechteck `from` (Knopf, Stundenplan-Eintrag) an ihre Stelle und kehrt beim Schliessen dorthin
 *  zurueck. `kids` (Inhalt) blenden spaeter ein bzw. frueher aus, damit nichts verzerrt zu lesen ist. */
export function morph(box: HTMLElement, from: DOMRect | null, kids: HTMLElement[], opening: boolean, ms = opening ? 520 : 300): Promise<void> {
  if (!from || reduced()) return Promise.resolve();
  const to = box.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const small = `translate(${dx}px, ${dy}px) scale(${Math.max(0.03, from.width / to.width)}, ${Math.max(0.03, from.height / to.height)})`;
  const easing = opening ? "cubic-bezier(0.22, 1.12, 0.36, 1)" : "cubic-bezier(0.5, 0, 0.75, 0)";
  const main = box.animate(opening ? [{ transform: small }, { transform: "none" }] : [{ transform: "none" }, { transform: small }], { duration: ms, easing });
  for (const k of kids) k.animate(opening ? [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "linear" });
  return main.finished.then(() => undefined, () => undefined);
}
