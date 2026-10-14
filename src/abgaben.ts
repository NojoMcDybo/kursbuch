/** Abgaben (rechts unter dem Kalender): Fristen und Pruefungen der naechsten zwei Wochen mit Restzeit, nach Faelligkeit. Nur Symbol, Kurzname, Restzeit. */

import type { Ev } from "./api";
import { left, urgency } from "./dates";
import { KIND_ICON } from "./timeline";
import { el, hsl, ico } from "./ui";

export type AbgabenOpts = { hueOf: (course: number | null) => number | null; nameOf: (course: number | null) => string; onOpen: (course: number) => void };

const DAYS = 14;

export class Abgaben {
  readonly el = el("section", "ab");

  constructor(private o: AbgabenOpts) {}

  render(events: Ev[]) {
    const now = Date.now() / 1000;
    const due = events
      .filter((e) => (e.kind === "frist" || e.kind === "pruefung") && e.ts >= now - 12 * 3600 && e.ts <= now + DAYS * 86400)
      .sort((a, b) => a.ts - b.ts);
    const head = el("h3", "ab-h");
    head.append(ico("abgabe"), el("span", "", "Abgaben"), el("small", "", due.length ? String(due.length) : ""));
    const rows = due.map((e) => {
      const r = el("button", "ln");
      const h = this.o.hueOf(e.course);
      r.style.setProperty("--c", h == null ? "rgba(245,245,247,.8)" : hsl(h));
      r.title = `${this.o.nameOf(e.course)}\n${e.title}`;
      const chip = el("span", `chip-l u${e.overdue ? 2 : urgency(e.ts, e.allDay, now)}`, e.overdue ? "überfällig" : left(e.ts, e.allDay, now));
      r.append(ico(KIND_ICON[e.kind]), el("span", "ln-t", e.short), chip);
      r.addEventListener("click", () => { if (e.course != null) this.o.onOpen(e.course); });
      return r;
    });
    this.el.replaceChildren(head, ...rows);
  }
}
