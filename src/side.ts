/** Rechte Seite: Fristen (naechste Abgaben und Pruefungen mit Restzeit) und Neues seit dem letzten Oeffnen. Nur Symbole und Schlagwoerter. */

import { api, type Ev, type NewItem } from "./api";
import { left, urgency } from "./dates";
import type { IconName } from "./nojo/nojo-ui";
import { KIND_ICON } from "./timeline";
import { act, el, hsl, ico, iconBtn } from "./ui";

export type SideOpts = { hueOf: (course: number | null) => number | null; nameOf: (course: number | null) => string; onOpen: (course: number) => void; onRead: () => void };

const TYPE_ICON: Record<string, IconName> = {
  resource: "document", folder: "folder", url: "link", forum: "forum", assign: "abgabe", opencast: "video", zoom: "video",
  scheduler: "kalender", h5pactivity: "pointer", data: "layout", ratingallocate: "check", feedback: "check",
};
export const typeIcon = (t: string): IconName => TYPE_ICON[t] ?? "open";

export class Side {
  readonly el = el("aside", "side n-glass big");

  constructor(private o: SideOpts) {}

  render(events: Ev[], news: NewItem[]) {
    const now = Date.now() / 1000;
    const due = events.filter((e) => (e.kind === "frist" || e.kind === "pruefung") && e.ts >= now - 12 * 3600).slice(0, 9);

    const fr = el("section", "blk");
    const fh = el("h3", "blk-h");
    fh.append(ico("abgabe"), el("span", "", String(due.length || "")));
    fr.append(fh);
    for (const e of due) {
      const r = el("button", "ln");
      const h = this.o.hueOf(e.course);
      r.style.setProperty("--c", h == null ? "rgba(245,245,247,.8)" : hsl(h));
      r.title = `${this.o.nameOf(e.course)}\n${e.title}`;
      const u = urgency(e.ts, e.allDay, now);
      const chip = el("span", `chip-l u${e.overdue ? 2 : u}`, e.overdue ? "überfällig" : left(e.ts, e.allDay, now));
      r.append(ico(KIND_ICON[e.kind]), el("span", "ln-t", e.short), chip);
      r.addEventListener("click", () => { if (e.course != null) this.o.onOpen(e.course); });
      fr.append(r);
    }

    const nw = el("section", "blk");
    const nh = el("h3", "blk-h");
    nh.append(ico("download"), el("span", "", String(news.length || "")));
    if (news.length) nh.append(iconBtn("check", "Gelesen", "n-ico sm blk-x", () => { act(api.markRead().then(this.o.onRead)); }));
    nw.append(nh);
    for (const n of news) {
      const r = el("button", "ln");
      const h = this.o.hueOf(n.course);
      r.style.setProperty("--c", h == null ? "rgba(245,245,247,.8)" : hsl(h));
      r.title = `${this.o.nameOf(n.course)}\n${n.name}`;
      const mark = n.updated ? el("span", "chip-l") : el("i", "dot");
      if (n.updated) { mark.append(ico("refresh")); mark.title = "Aktualisiert"; }
      r.append(ico(typeIcon(n.typ)), el("span", "ln-t", n.name), mark);
      r.addEventListener("click", () => {
        if (n.file != null) act(api.openFile(n.course, n.cmid, n.file));
        else this.o.onOpen(n.course);
      });
      nw.append(r);
    }
    this.el.replaceChildren(fr, nw);
  }
}
