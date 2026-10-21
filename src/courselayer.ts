/**
 * Kurs im gleichen Fenster: ein Layer ueber dem Dashboard (nicht Vollbild) mit der ganzen Kursseite (Ankuendigungen, Abschnitte, rechts
 * Abgaben und Dozenten). Er waechst aus dem angeklickten Element, Esc, das Kreuz oder ein Klick daneben schliessen ihn. Wer einen
 * zweiten Kurs oeffnet (Suche, Zeitstrahl, Stundenplan), tauscht den Inhalt. Fuer Wunsch nach mehr Platz: Knopf „In eigenem Fenster“
 * (das alte Kursfenster, windows.rs).
 */

import { api } from "./api";
import { CoursePage, type Target } from "./coursepage";
import { act, el, iconBtn, morph, toast } from "./ui";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class CourseLayer {
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private page: CoursePage | null = null;
  private id = 0;
  private closing = false;
  /** das zuletzt angeklickte Element: dort waechst der Layer heraus (auch wenn der Aufruf von weiter weg kommt) */
  private last: DOMRect | null = null;
  private from: DOMRect | null = null;
  private target: Target = {};
  private opener: HTMLElement | null = null;

  constructor() {
    document.addEventListener("pointerdown", (e) => { this.last = (e.target as HTMLElement | null)?.closest("button")?.getBoundingClientRect() ?? null; }, true);
  }

  get isOpen() { return !!this.root && !this.closing; }

  /** Kurs zeigen; `target` = Aktivitaet oder Abschnitt, die in die Mitte kommen und aufblinken */
  async open(id: number, target: Target = {}) {
    if (this.root && !this.closing && this.id === id) { this.page?.reveal(target); return; }
    this.id = id;
    this.target = target;
    const first = !this.root || this.closing;
    if (first) this.build(); else this.swap();
    const page = this.page!;
    if (!(await page.load())) {
      toast("Kurs nicht gefunden");
      this.close();
      return;
    }
    if (target.cmid != null || target.section) window.setTimeout(() => page.reveal(target), first ? 520 : 200);
  }

  /** Stand neu holen (Fenster bekommt den Fokus, Sync ist durch) */
  refresh() { if (this.isOpen) void this.page?.load(); }

  private newPage() {
    const page = new CoursePage(this.id, (v) => this.panel?.setAttribute("aria-label", v.title), false);
    this.page = page;
    return page;
  }

  private build() {
    this.root?.remove();
    this.closing = false;
    this.from = this.last;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; // dorthin kehrt der Fokus zurueck
    const root = el("div", "clay");
    const scrim = el("div", "clay-scrim");
    scrim.addEventListener("pointerdown", () => this.close());
    const panel = el("section", "clay-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;
    const tools = el("div", "clay-tools");
    tools.append(
      iconBtn("fullscreen", "In eigenem Fenster öffnen", "n-ico sm n-glass n-liquid", () => { act(api.openCourse(this.id, this.target.cmid ?? undefined, this.target.section ?? undefined)); this.close(); }),
      iconBtn("close", "Schließen (Esc)", "n-ico sm n-glass n-liquid", () => this.close()),
    );
    const page = this.newPage();
    panel.append(page.el, tools);
    root.append(scrim, panel);
    document.body.append(root);
    this.root = root;
    this.panel = panel;
    if (this.from) void morph(panel, this.from, [page.el, tools], true);
    else if (!reduced()) panel.animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], { duration: 380, easing: "cubic-bezier(0.22, 1.08, 0.36, 1)" });
    panel.focus({ preventScroll: true });
  }

  /** anderer Kurs bei offenem Layer: Inhalt wechselt mit einem kurzen Ueberblenden */
  private swap() {
    const panel = this.panel!, old = this.page!.el;
    const page = this.newPage();
    old.replaceWith(page.el);
    if (!reduced()) page.el.animate([{ opacity: 0, translate: "0 10px" }, { opacity: 1, translate: "0 0" }], { duration: 320, easing: "cubic-bezier(0.22, 1.08, 0.36, 1)" });
    panel.setAttribute("aria-label", "");
  }

  close() {
    const root = this.root, panel = this.panel;
    if (!root || !panel || this.closing) return;
    this.closing = true;
    root.classList.add("out");
    const done = () => { if (this.root === root) { root.remove(); this.root = null; this.panel = null; this.page = null; this.closing = false; this.opener?.focus({ preventScroll: true }); } else root.remove(); };
    if (reduced()) return done();
    if (this.from) void morph(panel, this.from, [...panel.children] as HTMLElement[], false, 260).then(done, done);
    else panel.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.96 }], { duration: 220, easing: "ease-in", fill: "forwards" }).finished.then(done, done);
  }
}
