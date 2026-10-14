/** Agenda (links unter dem Kalender): die naechsten Termine nach Tagen, aller Arten. Nur Tag, Symbol, Kurzname, Uhrzeit. */

import type { Ev } from "./api";
import { dateOf, dayOfTs, todayDay, weekday } from "./dates";
import { KIND_ICON } from "./timeline";
import { el, hsl, ico } from "./ui";

export type AgendaOpts = { hueOf: (course: number | null) => number | null; nameOf: (course: number | null) => string; onOpen: (course: number) => void };

const MAX_ROWS = 18;
const HORIZON_DAYS = 45;

export class Agenda {
  readonly el = el("section", "agenda n-glass big");

  constructor(private o: AgendaOpts) {}

  render(events: Ev[]) {
    const today = todayDay();
    const now = Date.now() / 1000;
    const next = events
      .filter((e) => dayOfTs(e.ts) >= today && dayOfTs(e.ts) <= today + HORIZON_DAYS && (e.allDay || e.ts >= now - 3600))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, MAX_ROWS);
    const out: HTMLElement[] = [];
    let day = -1;
    for (const e of next) {
      const d = dayOfTs(e.ts);
      if (d !== day) {
        day = d;
        const date = dateOf(d);
        const h = el("h4", "ag-d", d === today ? "Heute" : `${weekday(date)} ${date.getDate()}.${date.getMonth() + 1}.`);
        if (d === today) h.classList.add("now");
        out.push(h);
      }
      const r = el("button", "ag-e");
      const hue = this.o.hueOf(e.course);
      r.style.setProperty("--c", hue == null ? "rgba(245,245,247,.8)" : hsl(hue));
      r.title = `${this.o.nameOf(e.course)}\n${e.title}`;
      const time = e.allDay ? "" : new Date(e.ts * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      r.append(ico(KIND_ICON[e.kind]), el("span", "ag-t", e.short), el("small", "", time));
      r.addEventListener("click", () => { if (e.course != null) this.o.onOpen(e.course); });
      out.push(r);
    }
    this.el.replaceChildren(...out);
    this.el.hidden = !out.length;
  }
}
