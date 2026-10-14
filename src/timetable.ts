/**
 * Stundenplan (Mitte): Woche Montag bis Freitag (Samstag und Sonntag nur, wenn es dort Eintraege gibt), Stunden senkrecht.
 * Eintraege schreibt man selbst (leere Stelle anklicken oder das Plus), importiert sie aus einer .ics-Datei oder exportiert sie fuer
 * Apple- und Google-Kalender. Ein Klick auf einen Eintrag schiebt eine Karte nach vorn: Zeit, Ort, naechster Termin, Dateien,
 * Neues und Verweise auf die Kursseite in Kursbuch und auf LearnWeb. Gespeichert wird je Semester (Rust: timetable.rs).
 */

import { api, type CourseCard, type Entry, type Ev, type Plans } from "./api";
import { left, urgency, weekdayIndex } from "./dates";
import { KIND_ICON } from "./timeline";
import { act, el, hsl, ico, iconBtn, message, morph, shortSem, toast } from "./ui";

const HOUR = 52; // Pixel je Stunde (mindestens; bei hohem Fenster waechst die Stunde, bis der Plan die Hoehe fuellt)
const HOUR_MAX = 96;
const DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const parseHm = (s: string) => { const [h, m] = s.split(":").map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; };
const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, "").slice(0, 20);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const sameSlot = (a: Entry, b: Entry) => a.title === b.title && a.day === b.day && a.start === b.start && a.end === b.end;

export type TimetableOpts = {
  semester: () => string;
  /** Kurse des gewaehlten Semesters (fuer die Auswahl im Editor) */
  courses: () => CourseCard[];
  card: (course: number | null) => CourseCard | undefined;
  nextOf: (course: number) => Ev | undefined;
  newOf: (course: number) => number;
  openCourse: (course: number) => void;
  openWeb: (course: number) => void;
};

export class Timetable {
  readonly el = el("section", "tt");
  private plans: Plans = {};
  private sem = "";
  private bar = el("header", "tt-h");
  private scroll = el("div", "tt-scroll");
  private layer = el("div", "tt-layer");
  private file = el("input");
  private closeLayer: (() => Promise<void>) | null = null;
  private scrolled = "";

  constructor(private o: TimetableOpts) {
    this.file.type = "file";
    this.file.accept = ".ics,text/calendar";
    this.file.hidden = true;
    this.file.addEventListener("change", () => void this.importFile());
    this.layer.hidden = true;
    this.el.append(this.bar, this.scroll, this.layer, this.file);
    this.layer.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); void this.close(); } });
    void this.reload();
    window.setInterval(() => this.draw(), 60_000); // die Linie „jetzt“ wandert
    let h = this.scroll.clientHeight;
    new ResizeObserver(() => { if (Math.abs(this.scroll.clientHeight - h) > 1) { h = this.scroll.clientHeight; this.draw(); } }).observe(this.scroll);
  }

  async reload() {
    this.plans = await api.timetableGet().catch((e) => { toast(message(e)); return {} as Plans; });
    this.draw();
  }

  /** Kursfarben, Namen und Zahlen haben sich geaendert */
  refresh() { this.draw(); }

  /** Semester gewechselt: anderer Plan */
  setSemester(s: string) {
    if (s === this.sem) return;
    this.sem = s;
    void this.close();
    this.draw();
  }

  private get entries(): Entry[] { return this.plans[this.sem] ?? []; }

  private async save(list: Entry[]) {
    try {
      await api.timetableSave(this.sem, list);
      this.plans = { ...this.plans };
      if (list.length) this.plans[this.sem] = list; else delete this.plans[this.sem];
      this.draw();
    } catch (e) {
      toast(message(e));
    }
  }

  // ----------------------------------------------------------------- Zeichnen

  private draw() {
    this.drawBar();
    this.drawGrid();
  }

  private drawBar() {
    const title = el("h2", "tt-title", "Stundenplan");
    if (this.sem) title.append(el("small", "", shortSem(this.sem)));
    const acts = el("div", "tt-acts");
    const exp = iconBtn("share", "Für Apple oder Google Kalender exportieren (.ics)", "n-ico sm n-glass n-liquid", () => this.exportForm(exp));
    exp.disabled = !this.entries.length;
    acts.append(
      iconBtn("download", "Aus .ics importieren", "n-ico sm n-glass n-liquid", () => this.file.click()),
      exp,
      iconBtn("plus", "Neuer Eintrag", "n-ico sm n-glass n-liquid", () => this.editor({ day: Math.min(4, weekdayIndex(new Date())), start: 600, end: 720 })),
    );
    this.bar.replaceChildren(title, acts);
  }

  private drawGrid() {
    const list = this.entries;
    const days = Math.max(5, ...list.map((e) => e.day + 1));
    const from = Math.min(8 * 60, ...list.map((e) => Math.floor(e.start / 60) * 60));
    const to = Math.max(18 * 60, ...list.map((e) => Math.ceil(e.end / 60) * 60));
    const hours = (to - from) / 60;
    const hour = Math.max(HOUR, Math.min(HOUR_MAX, Math.floor((this.scroll.clientHeight - 64) / hours)));
    const today = weekdayIndex(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

    const grid = el("div", "tt-grid");
    grid.style.setProperty("--days", String(days));
    grid.style.setProperty("--hour", `${hour}px`);
    const names = el("div", "tt-names");
    names.append(el("span"));
    for (let d = 0; d < days; d++) names.append(el("span", d === today ? "tt-day today" : "tt-day", DAYS[d]));

    const body = el("div", "tt-body");
    body.style.height = `${hours * hour}px`;
    const gutter = el("div", "tt-gutter");
    for (let h = 0; h <= hours; h++) {
      const l = el("span", "tt-hr", h === hours ? "" : hm(from + h * 60));
      l.style.top = `${h * hour}px`;
      gutter.append(l);
    }
    body.append(gutter);
    for (let d = 0; d < days; d++) {
      const col = el("div", d === today ? "tt-col today" : "tt-col");
      col.addEventListener("click", (e) => {
        if (e.target !== col) return;
        const start = Math.min(1440 - 60, from + Math.floor((e.offsetY / hour) * 2) * 30);
        this.editor({ day: d, start, end: Math.min(1440, start + 120) });
      });
      for (const [e, lane, lanes] of lay(list.filter((x) => x.day === d))) col.append(this.block(e, from, hour, lane, lanes));
      if (d === today && nowMin >= from && nowMin <= to) {
        const line = el("i", "tt-now");
        line.style.top = `${((nowMin - from) / 60) * hour}px`;
        col.append(line);
      }
      body.append(col);
    }
    grid.append(names, body);
    const top = this.scroll.scrollTop;
    this.scroll.replaceChildren(grid);
    if (!list.length) {
      const empty = el("div", "tt-empty");
      empty.append(ico("kalender", 34), el("p", "", "Noch kein Stundenplan"));
      const b = el("div", "tt-empty-b");
      b.append(iconBtn("plus", "Neuer Eintrag", "n-ico n-glass n-liquid", () => this.editor({ day: 0, start: 600, end: 720 })), iconBtn("download", "Aus .ics importieren", "n-ico n-glass n-liquid", () => this.file.click()));
      empty.append(b);
      this.scroll.append(empty);
    }
    // erste Darstellung eines Semesters: zum fruehesten Eintrag blaettern; danach Stand halten
    const key = `${this.sem}|${list.length ? 1 : 0}`;
    if (this.scrolled !== key) {
      this.scrolled = key;
      const first = list.length ? Math.min(...list.map((e) => e.start)) : from;
      this.scroll.scrollTop = Math.max(0, ((first - from) / 60 - 0.5) * hour);
    } else this.scroll.scrollTop = top;
  }

  private block(e: Entry, from: number, hour: number, lane: number, lanes: number) {
    const b = el("button", "tt-b");
    const c = this.o.card(e.course);
    b.style.setProperty("--c", c ? hsl(c.hue) : "rgba(200,205,215,.9)");
    b.style.top = `${((e.start - from) / 60) * hour + 1}px`;
    b.style.height = `${((e.end - e.start) / 60) * hour - 2}px`;
    b.style.left = `calc(${(lane / lanes) * 100}% + 2px)`;
    b.style.width = `calc(${100 / lanes}% - 4px)`;
    b.title = `${e.title}\n${hm(e.start)}–${hm(e.end)}${e.room ? `\n${e.room}` : ""}`;
    b.append(el("span", "tt-bt", e.title), el("span", "tt-bm", `${hm(e.start)}–${hm(e.end)}${e.room ? ` · ${e.room}` : ""}`));
    b.addEventListener("click", () => void this.info(e, b.getBoundingClientRect()));
    return b;
  }

  // ----------------------------------------------------------------- Karte und Formulare (liegen ueber dem Plan)

  private async close() {
    const f = this.closeLayer;
    this.closeLayer = null;
    if (f) await f();
  }

  /** Karte oder Formular ueber den Plan legen; `from` = Rechteck, aus dem sie wachsen */
  private async open(card: HTMLElement, from: DOMRect | null) {
    await this.close();
    const scrim = el("div", "tt-scrim");
    scrim.addEventListener("pointerdown", () => void this.close());
    this.layer.replaceChildren(scrim, card);
    this.layer.hidden = false;
    const kids = [...card.children] as HTMLElement[];
    void morph(card, from, kids, true);
    card.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
    this.closeLayer = async () => {
      await morph(card, from, kids, false);
      this.layer.hidden = true;
      this.layer.replaceChildren();
    };
  }

  private async info(e: Entry, from: DOMRect) {
    const c = this.o.card(e.course);
    const card = el("article", "ti");
    card.style.setProperty("--c", c ? hsl(c.hue) : "rgba(200,205,215,.9)");
    const head = el("header", "ti-h");
    head.append(el("i", "ti-dot"), el("h3", "", e.title), iconBtn("close", "Schließen", "n-ico sm", () => void this.close()));
    const facts = el("ul", "ti-f");
    const fact = (icon: Parameters<typeof ico>[0], text: string, cls = "") => { const li = el("li", cls); li.append(ico(icon), el("span", "", text)); facts.append(li); return li; };
    fact("kalender", `${DAYS[e.day]} · ${hm(e.start)}–${hm(e.end)}`);
    if (e.room) fact("pin", e.room);
    if (c?.teacher) fact("user", c.teacher);
    if (c) {
      const next = this.o.nextOf(c.id);
      if (next) {
        const li = fact(KIND_ICON[next.kind], next.short);
        li.append(el("em", `ti-chip u${urgency(next.ts, next.allDay)}`, left(next.ts, next.allDay)));
      }
      fact("document", `${c.files}`);
      const n = this.o.newOf(c.id);
      if (n) fact("download", `${n} neu`, "ti-new");
    }
    const foot = el("footer", "ti-a");
    const links = el("div", "ti-l");
    if (c) {
      const open = el("button", "n-btn n-glass n-liquid");
      open.append(ico("open"), "Kurs");
      open.title = "Kursseite in Kursbuch";
      open.addEventListener("click", () => { void this.close(); this.o.openCourse(c.id); });
      const web = el("button", "n-btn n-glass n-liquid");
      web.append(ico("external"), "LearnWeb");
      web.title = "Kurs auf der Webseite von LearnWeb";
      web.addEventListener("click", () => this.o.openWeb(c.id));
      links.append(open, web);
    }
    const tools = el("div", "ti-t");
    tools.append(
      iconBtn("edit", "Bearbeiten", "n-ico sm", () => { const r = card.getBoundingClientRect(); void this.close().then(() => this.editor(e, r)); }),
      iconBtn("trash", "Löschen", "n-ico sm danger", () => { void this.close(); void this.save(this.entries.filter((x) => x.id !== e.id)); }),
    );
    foot.append(links, tools);
    card.append(head, facts, foot);
    await this.open(card, from);
  }

  /** Formular fuer einen neuen (ohne id) oder bestehenden Eintrag */
  private async editor(e: Partial<Entry> & { day: number; start: number; end: number }, from: DOMRect | null = null) {
    const form = el("form", "tf");
    form.noValidate = true;
    const title = el("input", "n-input");
    title.placeholder = "Titel";
    title.maxLength = 120;
    title.value = e.title ?? "";
    title.setAttribute("aria-label", "Titel");
    const course = el("select", "n-input");
    course.setAttribute("aria-label", "Kurs");
    course.append(new Option("Kein Kurs", ""));
    for (const c of this.o.courses()) course.append(new Option(c.title, String(c.id)));
    course.value = e.course != null && this.o.card(e.course) ? String(e.course) : "";
    course.addEventListener("change", () => { const c = this.o.card(Number(course.value)); if (c && !title.value.trim()) title.value = c.title; });
    let day = e.day;
    const seg = el("nav", "n-seg tf-days");
    const drawDays = () => seg.replaceChildren(...DAYS.map((n, i) => {
      const b = el("button", i === day ? "active" : "", n);
      b.type = "button";
      b.setAttribute("aria-pressed", String(i === day));
      b.addEventListener("click", () => { day = i; drawDays(); });
      return b;
    }));
    drawDays();
    const t1 = el("input", "n-input"), t2 = el("input", "n-input");
    for (const [t, v, label] of [[t1, e.start, "Von"], [t2, e.end, "Bis"]] as const) { t.type = "time"; t.step = "300"; t.value = hm(v); t.setAttribute("aria-label", label); }
    const times = el("div", "tf-times");
    times.append(t1, el("span", "", "–"), t2);
    const room = el("input", "n-input");
    room.placeholder = "Raum";
    room.maxLength = 80;
    room.value = e.room ?? "";
    room.setAttribute("aria-label", "Raum");
    const err = el("p", "tf-err");
    const save = el("button", "n-btn primary", "Speichern");
    save.type = "submit";
    const cancel = el("button", "n-btn", "Abbrechen");
    cancel.type = "button";
    cancel.addEventListener("click", () => void this.close());
    const foot = el("footer", "tf-a");
    foot.append(cancel, save);
    form.append(el("h3", "", e.id ? "Eintrag bearbeiten" : "Neuer Eintrag"), title, course, seg, times, room, err, foot);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const [s, t] = [parseHm(t1.value), parseHm(t2.value)];
      if (!title.value.trim()) { err.textContent = "Titel fehlt."; title.focus(); return; }
      if (!(s >= 0 && t > s && t <= 1440)) { err.textContent = "Die Uhrzeit passt nicht (Ende nach Beginn)."; return; }
      const entry: Entry = { id: e.id ?? newId(), title: title.value.trim(), day, start: s, end: t, room: room.value.trim(), course: course.value ? Number(course.value) : null };
      void this.close();
      void this.save(e.id ? this.entries.map((x) => (x.id === e.id ? entry : x)) : [...this.entries, entry]);
    });
    await this.open(form, from);
    title.focus();
  }

  // ----------------------------------------------------------------- Import und Export

  private async importFile() {
    const f = this.file.files?.[0];
    this.file.value = "";
    if (!f) return;
    try {
      const r = await api.timetableImport(await f.text());
      const have = this.entries;
      const fresh = r.entries.filter((n) => !have.some((x) => sameSlot(x, n))).map((n) => ({ ...n, course: this.guessCourse(n.title) }));
      if (fresh.length) await this.save([...have, ...fresh]);
      toast(`${fresh.length} importiert${r.skipped ? ` · ${r.skipped} übersprungen` : ""}${r.entries.length - fresh.length ? ` · ${r.entries.length - fresh.length} schon da` : ""}`);
    } catch (e) {
      toast(message(e));
    }
  }

  /** Kurs des Semesters, dessen Name zum Titel passt (gleich oder genau ein Kurs enthaelt ihn); sonst keiner */
  private guessCourse(title: string): number | null {
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const t = norm(title);
    if (t.length < 4) return null;
    const list = this.o.courses();
    const exact = list.filter((c) => norm(c.title) === t);
    if (exact.length === 1) return exact[0].id;
    const part = list.filter((c) => norm(c.title).includes(t) || t.includes(norm(c.title)));
    return part.length === 1 ? part[0].id : null;
  }

  /** Kleines Formular: Zeitraum der woechentlichen Wiederholung, dann .ics in „Downloads“ */
  private exportForm(anchor: HTMLElement) {
    const mon = new Date();
    mon.setDate(mon.getDate() - weekdayIndex(mon));
    const end = new Date(mon);
    end.setDate(end.getDate() + 15 * 7 - 1);
    const form = el("form", "tf tx");
    form.noValidate = true;
    const a = el("input", "n-input"), b = el("input", "n-input");
    for (const [i, v, l] of [[a, mon, "Von"], [b, end, "Bis"]] as const) { i.type = "date"; i.value = iso(v); i.setAttribute("aria-label", l); }
    const row = el("div", "tf-times");
    row.append(a, el("span", "", "–"), b);
    const go = el("button", "n-btn primary");
    go.type = "submit";
    go.append(ico("share"), "Exportieren");
    const foot = el("footer", "tf-a");
    foot.append(go);
    form.append(el("h3", "", "Wöchentlich wiederholen"), row, foot);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      act(api.timetableExport(this.sem, a.value, b.value).then((p) => { void this.close(); toast(`Gespeichert in Downloads · ${p.split("\\").pop()}`); }));
    });
    void this.open(form, anchor.getBoundingClientRect());
  }
}

/** Ueberlappende Eintraege eines Tages nebeneinander: (Eintrag, Spur, Spuren der Gruppe) */
export function lay(day: Entry[]): [Entry, number, number][] {
  const sorted = [...day].sort((x, y) => x.start - y.start || y.end - x.end);
  const out: [Entry, number, number][] = [];
  let group: { e: Entry; lane: number }[] = [];
  let groupEnd = 0;
  const flush = () => { const n = Math.max(1, ...group.map((g) => g.lane + 1)); for (const g of group) out.push([g.e, g.lane, n]); group = []; };
  for (const e of sorted) {
    if (group.length && e.start >= groupEnd) flush();
    // erste Spur, in der der letzte Eintrag schon zu Ende ist
    const ends: number[] = [];
    for (const g of group) ends[g.lane] = Math.max(ends[g.lane] ?? 0, g.e.end);
    let lane = ends.findIndex((t) => t <= e.start);
    if (lane < 0) lane = ends.length;
    group.push({ e, lane });
    groupEnd = Math.max(groupEnd, e.end);
  }
  flush();
  return out;
}
