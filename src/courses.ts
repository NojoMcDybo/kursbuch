/**
 * Kurse: Zustand (Semester, Kursraster mit Farbtoenen) und die Liste links, aus der man einen Kurs in einem eigenen Fenster
 * oeffnet. Neues (seit dem letzten Oeffnen) steht als Zahl hinter dem Kurs; das Haekchen setzt es zurueck.
 */

import { api, type CourseCard, type NewItem, type Overview } from "./api";
import { makeDraggable, type DropTarget } from "./drag";
import { act, el, ico, iconBtn } from "./ui";

export type CoursesOpts = {
  onOpen: (course: number) => void;
  /** „Neu“ wurde zurueckgesetzt: Stand neu holen */
  onRead: () => void;
  /** Ziel fuers Ziehen einer Zeile (Stundenplan-Eintrag zuordnen) */
  drag: DropTarget;
};

/** Das Semester, in dem heute liegt (Oktober-Maerz = WiSe, April-September = SoSe) */
export function semesterNow(d = new Date()): string {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (m >= 10) return `WiSe ${y}/${String((y + 1) % 100).padStart(2, "0")}`;
  if (m <= 3) return `WiSe ${y - 1}/${String(y % 100).padStart(2, "0")}`;
  return `SoSe ${y}`;
}

export class Courses {
  readonly el = el("nav", "cl");
  private ov: Overview | null = null;
  private sem = "";
  private news = new Map<number, number>();
  /** Zeilen steigen nacheinander auf: beim ersten Zeichnen und beim Semesterwechsel, nicht bei jeder kleinen Aenderung */
  private enter = true;

  constructor(private o: CoursesOpts) {
    this.el.setAttribute("aria-label", "Kurse");
  }

  get cards(): CourseCard[] { return this.ov?.courses ?? []; }
  card(id: number | null) { return id == null ? undefined : this.cards.find((c) => c.id === id); }
  hueOf = (id: number | null) => this.card(id)?.hue ?? null;
  nameOf = (id: number | null) => this.card(id)?.title ?? "";
  get semester() { return this.sem; }
  /** neueste zuerst; „Weitere“ (Kurse ohne Semester) zuletzt */
  semesters(): string[] { return [...new Set(this.cards.map((c) => c.semester ?? "Weitere"))]; }
  inSemester() { return this.cards.filter((c) => (c.semester ?? "Weitere") === this.sem); }
  semesterIds() { return this.inSemester().map((c) => c.id); }
  newOf = (id: number) => this.news.get(id) ?? 0;
  /** Farbtoene des Semesters (Nebel) */
  hues() { return this.inSemester().map((c) => c.hue); }

  setOverview(ov: Overview) {
    this.ov = ov;
    const sems = this.semesters();
    if (!sems.includes(this.sem)) {
      const want = (() => { try { return localStorage.getItem("kursbuch-sem") ?? ""; } catch { return ""; } })();
      this.sem = sems.includes(want) ? want : sems.includes(semesterNow()) ? semesterNow() : sems[0] ?? "";
    }
    this.draw();
  }

  setNews(list: NewItem[]) {
    this.news = new Map();
    for (const n of list) this.news.set(n.course, (this.news.get(n.course) ?? 0) + 1);
    this.draw();
  }

  setSemester(s: string) {
    if (s === this.sem) return;
    this.sem = s;
    try { localStorage.setItem("kursbuch-sem", s); } catch { /* egal */ }
    this.enter = true;
    this.draw();
  }

  private draw() {
    const list = [...this.inSemester()].sort((a, b) => a.title.localeCompare(b.title, "de"));
    const total = list.reduce((n, c) => n + this.newOf(c.id), 0);
    const head = el("h3", "cl-h");
    head.append(ico("kursbuch"), el("span", "", "Kurse"), el("small", "", list.length ? String(list.length) : ""));
    if (total) head.append(iconBtn("check", "Neues als gelesen markieren", "n-ico sm cl-x", () => act(api.markRead().then(this.o.onRead))));
    const rows = list.map((c) => {
      const b = el("button", "cl-r");
      b.style.setProperty("--c", `hsl(${c.hue} 68% 62%)`);
      b.title = [c.title, c.kind && { vorlesung: "Vorlesung", seminar: "Seminar", uebung: "Übung" }[c.kind], c.teacher, "Auf einen Eintrag im Stundenplan ziehen, um ihn zuzuordnen"].filter(Boolean).join("\n");
      b.append(el("i", "cl-dot"), el("span", "cl-t", c.title));
      const n = this.newOf(c.id);
      if (n) { const badge = el("span", "cl-n", String(n)); badge.title = `${n} neu oder aktualisiert`; b.append(badge); }
      b.addEventListener("click", () => this.o.onOpen(c.id));
      makeDraggable(b, c, this.o.drag);
      return b;
    });
    rows.forEach((r, i) => r.style.setProperty("--i", String(i)));
    this.el.replaceChildren(head, ...rows);
    if (this.enter && rows.length) {
      this.enter = false;
      this.el.classList.add("enter");
      window.setTimeout(() => this.el.classList.remove("enter"), 600 + rows.length * 30);
    }
  }
}
