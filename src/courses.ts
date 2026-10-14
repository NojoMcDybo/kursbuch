/**
 * Mitte: oben die Kurse des gewaehlten Semesters als Chips (schneller Wechsel), darunter die geoeffneten Kurse als
 * fortlaufende Seiten nebeneinander (so viele, wie in die Fensterbreite passen, sonst seitlich blaettern).
 * Ist nichts geoeffnet, zeigt die Mitte die Kurse des Semesters als grosse Kacheln.
 */

import { api, type CourseCard, type CourseView, type Ev, type ItemView, type Overview } from "./api";
import { left, urgency } from "./dates";
import { lightScroller, type IconName } from "./nojo/nojo-ui";
import { typeIcon } from "./side";
import { KIND_ICON } from "./timeline";
import { act, announce, el, hsl, ico, iconBtn } from "./ui";

const MIN_PANE = 500;
const GAP = 14;
const KEY_OPEN = "kursbuch-open";
type Scroller = ReturnType<typeof lightScroller>;

export type CoursesOpts = {
  /** naechster Termin des Kurses (fuer die Kachel) */
  nextOf: (course: number) => Ev | undefined;
  /** Semester oder geoeffnete Kurse haben sich geaendert (Nebel, Zeitstrahl, Kalender nachziehen) */
  onChange: () => void;
};

/** Das Semester, in dem heute liegt (Oktober-Maerz = WiSe, April-September = SoSe) */
export function semesterNow(d = new Date()): string {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (m >= 10) return `WiSe ${y}/${String((y + 1) % 100).padStart(2, "0")}`;
  if (m <= 3) return `WiSe ${y - 1}/${String(y % 100).padStart(2, "0")}`;
  return `SoSe ${y}`;
}

export class Courses {
  readonly el = el("main", "center");
  private strip = el("div", "strip");
  private stage = el("div", "stage");
  private panes: HTMLElement | null = null;
  private ov: Overview | null = null;
  private sem = "";
  private opened: number[] = [];
  private views = new Map<number, CourseView>();
  private sigs = new Map<number, string>();
  private scrollers = new Map<number, Scroller>();

  constructor(private o: CoursesOpts) {
    this.el.append(this.strip, this.stage);
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_OPEN) ?? "[]");
      if (Array.isArray(saved)) this.opened = saved.filter((n) => Number.isInteger(n));
    } catch { /* egal */ }
    new ResizeObserver(() => this.fit()).observe(this.stage);
  }

  // ----------------------------------------------------------------- Zustand

  get cards(): CourseCard[] { return this.ov?.courses ?? []; }
  card(id: number | null) { return id == null ? undefined : this.cards.find((c) => c.id === id); }
  hueOf = (id: number | null) => this.card(id)?.hue ?? null;
  nameOf = (id: number | null) => this.card(id)?.title ?? "";
  get semester() { return this.sem; }
  semesters(): string[] { return [...new Set(this.cards.map((c) => c.semester ?? "Weitere"))]; }
  /** Farbtoene fuer den Nebel: die des Semesters, dazu die der geoeffneten Kurse (betont) */
  hues(): { base: number[]; open: number[] } {
    const open = this.opened.map((id) => this.card(id)?.hue).filter((h): h is number => h != null);
    return { base: this.inSemester().map((c) => c.hue), open };
  }
  openIds() { return [...this.opened]; }
  private inSemester() { return this.cards.filter((c) => (c.semester ?? "Weitere") === this.sem); }

  setOverview(ov: Overview) {
    this.ov = ov;
    const sems = this.semesters();
    if (!sems.includes(this.sem)) {
      const want = (() => { try { return localStorage.getItem("kursbuch-sem") ?? ""; } catch { return ""; } })();
      this.sem = sems.includes(want) ? want : sems.includes(semesterNow()) ? semesterNow() : sems[0] ?? "";
    }
    this.opened = this.opened.filter((id) => this.card(id));
    this.draw();
    void this.reload();
  }

  setSemester(s: string) {
    if (s === this.sem) return;
    this.sem = s;
    try { localStorage.setItem("kursbuch-sem", s); } catch { /* egal */ }
    this.draw();
    this.o.onChange();
  }

  // ----------------------------------------------------------------- oeffnen und schliessen

  /** Kurs oeffnen (und sein Semester waehlen); false, wenn es ihn nicht gibt */
  async open(id: number): Promise<boolean> {
    const c = this.card(id);
    if (!c) return false;
    if ((c.semester ?? "Weitere") !== this.sem) this.setSemester(c.semester ?? "Weitere");
    if (!this.opened.includes(id)) { this.opened.push(id); this.save(); }
    await this.load(id);
    this.draw();
    this.o.onChange();
    this.panes?.querySelector<HTMLElement>(`.pane[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
    announce(c.title);
    return true;
  }

  close(id: number) {
    this.opened = this.opened.filter((x) => x !== id);
    this.save();
    const p = this.panes?.querySelector<HTMLElement>(`.pane[data-id="${id}"]`);
    const done = () => { this.dispose(id); this.draw(); this.o.onChange(); };
    if (p && !matchMedia("(prefers-reduced-motion: reduce)").matches) { p.classList.add("closing"); window.setTimeout(done, 220); } else done();
  }

  closeAll() { for (const id of [...this.opened]) { this.opened = this.opened.filter((x) => x !== id); this.dispose(id); } this.save(); this.draw(); this.o.onChange(); }

  private save() { try { localStorage.setItem(KEY_OPEN, JSON.stringify(this.opened)); } catch { /* egal */ } }

  private dispose(id: number) {
    this.scrollers.get(id)?.dispose();
    this.scrollers.delete(id);
    this.views.delete(id);
    this.sigs.delete(id);
  }

  private async load(id: number) {
    try {
      this.views.set(id, await api.course(id));
    } catch {
      this.opened = this.opened.filter((x) => x !== id);
      this.save();
    }
  }

  /** Alle geoeffneten Kurse frisch laden; nur Seiten mit anderem Inhalt werden neu gezeichnet (Scrollstand bleibt) */
  private async reload() {
    await Promise.all(this.opened.map((id) => this.load(id)));
    this.draw();
  }

  // ----------------------------------------------------------------- Zeichnen

  private draw() {
    this.drawStrip();
    if (!this.opened.length) this.drawTiles();
    else this.drawPanes();
    this.fit();
  }

  private drawStrip() {
    const items: HTMLElement[] = this.inSemester().map((c) => {
      const b = el("button", "chip n-liquid");
      b.style.setProperty("--h", String(c.hue));
      const on = this.opened.includes(c.id);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.title = [c.title, c.teacher].filter(Boolean).join("\n");
      b.append(el("i", "chip-dot"), el("span", "chip-t", c.title));
      b.addEventListener("click", () => {
        if (on) this.panes?.querySelector<HTMLElement>(`.pane[data-id="${c.id}"]`)?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
        else void this.open(c.id);
      });
      return b;
    });
    if (this.opened.length) items.push(iconBtn("close", "Alle schließen", "n-ico sm n-glass n-liquid chip-x", () => this.closeAll()));
    this.strip.replaceChildren(...items);
  }

  private notice(icon: IconName, cls = "empty") {
    const d = el("div", cls);
    d.append(ico(icon, 34));
    return d;
  }

  private drawTiles() {
    this.disposeAll();
    this.panes = null;
    const o = this.ov;
    if (!o || o.status !== "ok" || !this.inSemester().length) {
      this.stage.replaceChildren(this.notice(o?.status === "error" ? "refresh" : "kursbuch"));
      return;
    }
    const grid = el("div", "tiles");
    this.inSemester().forEach((c, i) => grid.append(this.tile(c, i)));
    this.stage.replaceChildren(grid);
  }

  private tile(c: CourseCard, i: number) {
    const b = el("button", "tile n-liquid panel");
    b.style.setProperty("--h", String(c.hue));
    b.style.setProperty("--i", String(i));
    b.title = [c.title, c.teacher].filter(Boolean).join("\n");
    b.append(el("i", "tile-glow"), el("h3", "t-title", c.title));
    if (c.teacher) b.append(el("p", "t-teacher", c.teacher));
    const foot = el("div", "t-foot");
    const stat = (name: IconName, n: number, title: string, cls = "") => {
      const s = el("span", `t-stat ${cls}`.trim());
      s.title = title;
      s.append(ico(name), String(n));
      foot.append(s);
    };
    stat("document", c.files, "Dateien");
    if (c.skipped) stat("download", c.skipped, "zu groß zum Spiegeln", "warn");
    if (c.errors) stat("refresh", c.errors, "Download fehlgeschlagen", "warn");
    const next = this.o.nextOf(c.id);
    if (next) {
      const n = el("span", `t-next u${urgency(next.ts, next.allDay)}`);
      n.append(ico(KIND_ICON[next.kind]), left(next.ts, next.allDay));
      n.title = next.title;
      foot.append(n);
    }
    b.append(foot);
    b.addEventListener("click", () => void this.open(c.id));
    return b;
  }

  private disposeAll() { for (const id of [...this.scrollers.keys()]) { this.scrollers.get(id)?.dispose(); this.scrollers.delete(id); } this.sigs.clear(); }

  private drawPanes() {
    if (!this.panes || !this.stage.contains(this.panes)) {
      this.disposeAll();
      this.panes = el("div", "panes");
      this.panes.addEventListener("scroll", () => this.scrollers.forEach((s) => s.layout()), { passive: true });
      this.stage.replaceChildren(this.panes);
    }
    const host = this.panes;
    // Seiten in der Reihenfolge des Oeffnens; vorhandene bleiben stehen (Scrollstand), neue gleiten ein
    for (const id of this.opened) {
      const v = this.views.get(id);
      if (!v) continue;
      const sig = JSON.stringify(v);
      let p = host.querySelector<HTMLElement>(`.pane[data-id="${id}"]`);
      if (!p) {
        p = this.buildPane(v);
        host.append(p);
        const body = p.querySelector<HTMLElement>(".p-body")!;
        requestAnimationFrame(() => this.scrollers.set(id, lightScroller(body, { insetTop: 64, insetBottom: 12, edge: 6 })));
      } else if (this.sigs.get(id) !== sig) {
        const body = p.querySelector<HTMLElement>(".p-body")!;
        const top = body.scrollTop;
        this.fillBody(body, v);
        body.scrollTop = top;
      }
      this.sigs.set(id, sig);
    }
    for (const p of [...host.querySelectorAll<HTMLElement>(".pane")]) {
      if (!this.opened.includes(Number(p.dataset.id))) { this.scrollers.get(Number(p.dataset.id))?.dispose(); this.scrollers.delete(Number(p.dataset.id)); p.remove(); }
    }
    for (const id of this.opened) { const p = host.querySelector(`.pane[data-id="${id}"]`); if (p) host.append(p); } // Reihenfolge
  }

  /** So viele Seiten nebeneinander, wie in die Breite passen (mindestens eine, hoechstens so viele wie geoeffnet) */
  private fit() {
    if (!this.panes) return;
    const w = this.stage.clientWidth;
    const n = Math.max(1, Math.min(this.opened.length, Math.floor((w + GAP) / (MIN_PANE + GAP))));
    this.panes.style.setProperty("--fit", String(n));
    this.panes.classList.toggle("scrolls", this.opened.length > n);
    this.scrollers.forEach((s) => s.layout());
  }

  // ----------------------------------------------------------------- Kursseite

  private buildPane(v: CourseView) {
    const p = el("article", "pane n-glass big");
    p.dataset.id = String(v.id);
    p.style.setProperty("--h", String(v.hue));
    p.setAttribute("aria-label", v.title);
    const head = el("header", "p-head");
    const t = el("div", "p-titles");
    t.append(el("h2", "p-title", v.title));
    if (v.teacher) t.append(el("span", "p-sub", v.teacher));
    const acts = el("div", "p-acts");
    const web = iconBtn("external", "LearnWeb", "n-ico sm", () => act(api.openWeb(v.id)));
    web.disabled = !v.web;
    const note = iconBtn("open", v.note ? "Notiz in Obsidian" : "Noch keine Notiz", "n-ico sm", () => act(api.openNote(v.id)));
    note.disabled = !v.note;
    acts.append(web, note, iconBtn("folder", "Ordner", "n-ico sm", () => act(api.openFolder(v.id))), iconBtn("close", "Schließen", "n-ico sm", () => this.close(v.id)));
    head.append(el("i", "p-dot"), t, acts);
    const body = el("div", "p-body");
    this.fillBody(body, v);
    p.append(head, body);
    return p;
  }

  private fillBody(body: HTMLElement, v: CourseView) {
    const secs = v.sections.filter((s) => s.items.length).map((s) => {
      const sec = el("section", "sec");
      sec.append(el("h3", "sec-h", s.title));
      const ul = el("ul", "rows");
      for (const it of s.items) ul.append(this.item(v, it));
      sec.append(ul);
      return sec;
    });
    body.replaceChildren(...secs);
  }

  /** Datei -> Folio/Standardprogramm, Ordner -> Dateien darunter, Link -> Browser, Label -> Text */
  private item(v: CourseView, it: ItemView) {
    const li = el("li", "it");
    if (it.typ === "label") { li.className = "txt"; li.textContent = it.name; return li; }
    const row = (name: IconName, label: string, meta: string, run?: () => Promise<void>, cls = "") => {
      const r = el(run ? "button" : "div", `row ${cls}`.trim());
      r.append(ico(name), el("span", "r-name", label), el("span", "r-meta", meta));
      if (run) r.addEventListener("click", () => act(run()));
      return r;
    };
    const single = it.files.length === 1 && it.typ !== "folder";
    if (single) li.append(row(typeIcon(it.typ), it.name, it.files[0].ext.toUpperCase(), () => api.openFile(v.id, it.cmid, it.files[0].idx)));
    else if (it.files.length) {
      li.append(row(typeIcon(it.typ), it.name, String(it.files.length), undefined, "head"));
      for (const f of it.files) li.append(row("document", f.name, f.ext.toUpperCase(), () => api.openFile(v.id, it.cmid, f.idx), "sub"));
    } else if (it.web) {
      const r = row(typeIcon(it.typ), it.name, "", () => api.openWeb(v.id, it.cmid), "web");
      r.querySelector(".r-meta")!.append(ico("external", 13));
      li.append(r);
    } else li.append(row(typeIcon(it.typ), it.name, "", undefined, "plain"));
    for (const mb of it.skipped_mb) li.append(row("download", `${mb.toLocaleString("de-DE")} MB`, "", it.web ? () => api.openWeb(v.id, it.cmid) : undefined, "note"));
    if (it.error) li.append(row("refresh", "", "", undefined, "note"));
    return li;
  }

  /** Farbe eines Kurses fuer andere Teile der Oberflaeche */
  color(id: number | null, a = 1) { const h = this.hueOf(id); return h == null ? "rgba(245,245,247,.8)" : hsl(h, a); }
}
