/** Kalender (rechts oben, ohne eigene Karte): Monatsraster mit farbigen Punkten je Kurs; ein Tag antippen holt ihn in den Zeitstrahl. */

import type { Ev } from "./api";
import { MONTHS, dateOf, dayOf, dayOfTs, todayDay, weekdayIndex } from "./dates";
import { el, hsl, iconBtn } from "./ui";

export type CalendarOpts = { hueOf: (course: number | null) => number | null; onPick: (day: number) => void };

const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export class Calendar {
  readonly el = el("section", "cal");
  private shown = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private picked = todayDay();
  private events: Ev[] = [];

  constructor(private o: CalendarOpts) {
    this.draw();
  }

  setEvents(list: Ev[]) { this.events = list; this.draw(); }

  /** Tag waehlen (auch von aussen, z. B. beim Verschieben des Zeitstrahls); der Monat folgt */
  pick(day: number, notify = false) {
    this.picked = day;
    const d = dateOf(day);
    this.shown = new Date(d.getFullYear(), d.getMonth(), 1);
    this.draw();
    if (notify) this.o.onPick(day);
  }

  private go(delta: number) {
    this.shown = new Date(this.shown.getFullYear(), this.shown.getMonth() + delta, 1);
    this.draw();
  }

  private byDay() {
    const m = new Map<number, Ev[]>();
    for (const e of this.events) {
      const d = dayOfTs(e.ts);
      (m.get(d) ?? m.set(d, []).get(d)!).push(e);
    }
    return m;
  }

  private draw() {
    const by = this.byDay();
    const today = todayDay();
    const head = el("div", "cal-h");
    const title = el("button", "cal-m", `${MONTHS[this.shown.getMonth()]} ${this.shown.getFullYear()}`);
    title.title = "Heute";
    title.addEventListener("click", () => this.pick(today, true));
    head.append(iconBtn("prev", "Vorheriger Monat", "n-ico sm n-glass n-liquid", () => this.go(-1)), title, iconBtn("next", "Nächster Monat", "n-ico sm n-glass n-liquid", () => this.go(1)));

    const grid = el("div", "cal-g");
    for (const w of WD) grid.append(el("span", "cal-w", w));
    const first = new Date(this.shown.getFullYear(), this.shown.getMonth(), 1);
    const start = dayOf(first) - weekdayIndex(first);
    for (let i = 0; i < 42; i++) {
      const day = start + i;
      const date = dateOf(day);
      const b = el("button", "cal-d");
      b.append(el("span", "cal-n", String(date.getDate())));
      if (date.getMonth() !== this.shown.getMonth()) b.classList.add("out");
      if (i % 7 >= 5) b.classList.add("we");
      if (day === today) b.classList.add("today");
      if (day === this.picked) b.classList.add("picked");
      const evs = by.get(day);
      if (evs) {
        const dots = el("span", "cal-dots");
        const seen = new Set<number | null>();
        for (const e of evs) {
          if (seen.has(e.course) || seen.size >= 3) continue;
          seen.add(e.course);
          const dot = el("i");
          const h = this.o.hueOf(e.course);
          dot.style.background = h == null ? "rgba(245,245,247,.7)" : hsl(h);
          dots.append(dot);
        }
        b.append(dots);
        b.title = evs.map((e) => e.title).join("\n");
      }
      b.addEventListener("click", () => this.pick(day, true));
      grid.append(b);
    }

    this.el.replaceChildren(head, grid);
  }
}
