/**
 * Zeitstrahl ganz oben: Die Zeit ist in der Mitte aufgezogen und nach aussen gestaucht (Fischauge).
 * - Fokus: 14 Tage mit Tagesraster (Anfang `cur`, anfangs gestern bis in zwei Wochen), links davon die Vergangenheit,
 *   rechts die Zukunft, beide logarithmisch gestaucht (Wochenstriche, dann nur noch Monate).
 * - Scrollen (Mausrad), Ziehen oder die Pfeile schieben den Fokus; so liegen auch Klausuren in fuenf Monaten im
 *   Tagesraster. „Heute“ holt ihn zurueck. Die Bewegung ist gedaempft (Bewegung reduzieren: Sprung).
 * - Rahmen: Im Fokus alle Termine, ausserhalb nur Fristen und Pruefungen (als Punkte).
 * Gezeichnet werden Achse und Raster auf Canvas, die Termine als Knoepfe darueber (Tastatur, Hover, Klick).
 */

import type { Ev, EvKind } from "./api";
import type { IconName } from "./nojo/nojo-ui";
import { MON, dateOf, todayDay, dayOfTs, weekday, weekdayIndex, when } from "./dates";
import { el, hsl, iconBtn, ico } from "./ui";

const LENS = 14; // Tage im Fokus
const PAST = 45; // Horizont links (Tage)
const FUTURE = 230; // Horizont rechts (Tage), etwa acht Monate
const TAU_L = 10;
const TAU_R = 14;
const MIN_GOAL = -PAST + 12;
const MAX_GOAL = 330;
/** ab dieser Breite je Tag zeigt das Raster jeden Tag (sonst Wochen/Monate) */
const DAILY = 26;
const FONT = "'Segoe UI Variable Text','Segoe UI',sans-serif";

export const KIND_ICON: Record<EvKind, IconName> = { sitzung: "kalender", termin: "kalender", frist: "abgabe", pruefung: "timer" };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** kurzer Text fuer die Pille: Fuellwoerter weg, hoechstens 16 Zeichen */
export function shortTitle(t: string) {
  const s = t.replace(/^\s*(the\s+)?(deadline|abgabe)\s*(is|bis)?:?\s*/i, "").replace(/\s+/g, " ").trim() || t;
  return s.length > 16 ? `${s.slice(0, 15).trimEnd()}…` : s;
}

export type TimelineOpts = {
  hueOf: (course: number | null) => number | null;
  nameOf: (course: number | null) => string;
  onOpen: (course: number) => void;
};

type Geom = { pad: number; lensPx: number; leftPx: number; rightPx: number; x0: number };

export class Timeline {
  readonly el = el("section", "tl n-glass big");
  private cv = el("canvas", "tl-cv");
  private layer = el("div", "tl-layer");
  private tip = el("div", "tl-tip n-glass n-liquid");
  private ctx = this.cv.getContext("2d")!;
  private events: Ev[] = [];
  private nodes = new Map<string, HTMLButtonElement>();
  private cur = -1;
  private goal = -1;
  private raf = 0;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private axis = 0;
  private colors = { dim: "#a1a1a6", faint: "#6e6e73", ink: "#f5f5f7", accent: "#75b8ff" };

  constructor(private o: TimelineOpts) {
    this.el.tabIndex = 0;
    this.el.setAttribute("aria-label", "Zeitstrahl");
    this.tip.hidden = true;
    const left = iconBtn("prev", "Eine Woche zurück", "n-ico sm tl-btn l", () => this.shift(-7));
    const right = iconBtn("next", "Eine Woche vor", "n-ico sm tl-btn r", () => this.shift(7));
    const now = iconBtn("kalender", "Heute", "n-ico sm tl-btn t", () => this.today());
    this.el.append(this.cv, this.layer, left, right, now, this.tip);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * 0.022;
      this.goTo(this.goal + d * (1 + Math.abs(this.goal) / 40));
    }, { passive: false });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); this.shift((e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 7 : 1)); }
      else if (e.key === "Home") { e.preventDefault(); this.today(); }
    });
    this.drag();
    this.readColors();
  }

  // ----------------------------------------------------------------- Steuerung

  setEvents(list: Ev[]) {
    this.events = list;
    const keep = new Set(list.map((e) => e.id));
    for (const [id, n] of this.nodes) if (!keep.has(id)) { n.remove(); this.nodes.delete(id); }
    for (const ev of list) if (!this.nodes.has(ev.id)) this.nodes.set(ev.id, this.node(ev));
    this.paint();
  }

  /** Neu zeichnen, wenn sich Kursfarben aendern */
  refresh() { for (const ev of this.events) { const n = this.nodes.get(ev.id); if (n) this.tint(n, ev); } this.paint(); }

  /** einen Tag (Tageszahl) in die Mitte des Fokus holen */
  focusDay(day: number) { this.goTo(day - todayDay() - LENS / 2 + 0.5); }
  today() { this.goTo(-1); }
  private shift(days: number) { this.goTo(this.goal + days); }

  private goTo(g: number) {
    this.goal = clamp(g, MIN_GOAL, MAX_GOAL);
    if (reduced()) { this.cur = this.goal; this.paint(); return; }
    if (!this.raf) this.raf = requestAnimationFrame(() => this.step());
  }

  private step() {
    this.raf = 0;
    const diff = this.goal - this.cur;
    if (Math.abs(diff) < 0.004) { this.cur = this.goal; this.paint(); return; }
    this.cur += diff * 0.2;
    this.paint();
    this.raf = requestAnimationFrame(() => this.step());
  }

  private drag() {
    let x0 = 0, c0 = 0, active = false;
    this.el.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      active = true; x0 = e.clientX; c0 = this.goal;
      this.el.setPointerCapture(e.pointerId);
      this.el.classList.add("dragging");
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!active) return;
      const g = this.geom();
      const days = (-(e.clientX - x0) / (g.lensPx / LENS)) * (1 + Math.abs(c0) / 40);
      this.goal = clamp(c0 + days, MIN_GOAL, MAX_GOAL);
      this.cur = this.goal;
      this.paint();
    });
    const end = () => { active = false; this.el.classList.remove("dragging"); };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  // ----------------------------------------------------------------- Geometrie

  private resize() {
    this.dpr = Math.min(3, Math.max(1, devicePixelRatio || 1));
    this.W = this.el.clientWidth;
    this.H = this.el.clientHeight;
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = `${this.W}px`;
    this.cv.style.height = `${this.H}px`;
    this.axis = Math.round(this.H * 0.56);
    this.readColors();
    this.paint();
  }

  private readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    this.colors = { dim: v("--n-dim", "#a1a1a6"), faint: v("--n-faint", "#6e6e73"), ink: v("--n-ink", "#f5f5f7"), accent: v("--n-accent", "#75b8ff") };
  }

  private geom(): Geom {
    const pad = 46;
    const W = Math.max(200, this.W - 2 * pad);
    const lensPx = clamp(W * 0.58, Math.min(360, W * 0.8), 1100);
    const rest = W - lensPx;
    return { pad, lensPx, leftPx: rest * 0.28, rightPx: rest * 0.72, x0: pad + rest * 0.28 };
  }

  /** Pixel zu einer Tagesposition (Tage ab heute, auch gebrochen) */
  private x(d: number, g: Geom) {
    const s = this.cur, e = s + LENS;
    if (d >= s && d <= e) return g.x0 + ((d - s) / LENS) * g.lensPx;
    if (d < s) return g.x0 - g.leftPx * (Math.log1p((s - d) / TAU_L) / Math.log1p(PAST / TAU_L));
    return g.x0 + g.lensPx + g.rightPx * (Math.log1p((d - e) / TAU_R) / Math.log1p(FUTURE / TAU_R));
  }

  // ----------------------------------------------------------------- Zeichnen

  private paint() {
    if (!this.W) return;
    const g = this.geom();
    this.drawGrid(g);
    this.place(g);
  }

  private drawGrid(g: Geom) {
    const { ctx, W, H, axis, colors } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.lineCap = "round";
    // Achse, nach aussen auslaufend
    const grad = ctx.createLinearGradient(g.pad - 20, 0, W - g.pad + 20, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.12, "rgba(255,255,255,.2)");
    grad.addColorStop(0.88, "rgba(255,255,255,.2)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(g.pad - 20, axis); ctx.lineTo(W - g.pad + 20, axis); ctx.stroke();

    const today = todayDay();
    const base = dateOf(today);
    let lastLabel = -1e9;
    for (let d = Math.floor(this.cur - PAST); d <= Math.ceil(this.cur + LENS + FUTURE); d++) {
      const x1 = this.x(d, g), x2 = this.x(d + 1, g);
      if (x2 < g.pad - 30 || x1 > W - g.pad + 30) continue;
      const w = x2 - x1;
      const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
      const first = date.getDate() === 1;
      const past = d < 0;
      if (w >= DAILY) {
        if (weekdayIndex(date) >= 5) { ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(x1, 12, w, H - 24); }
        if (d === 0) {
          ctx.save(); ctx.fillStyle = "rgba(117,184,255,.2)"; ctx.beginPath(); ctx.roundRect(x1 + 3, axis + 10, w - 6, 40, 10); ctx.fill(); ctx.restore();
        }
        ctx.fillStyle = d === 0 ? colors.accent : past ? colors.faint : colors.ink;
        ctx.font = `600 14px ${FONT}`;
        ctx.fillText(String(date.getDate()), (x1 + x2) / 2, axis + 24);
        ctx.font = `500 10.5px ${FONT}`;
        ctx.fillStyle = d === 0 ? colors.accent : colors.faint;
        ctx.fillText(weekday(date), (x1 + x2) / 2, axis + 40);
        ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, axis - 4); ctx.lineTo(x1, axis + 5); ctx.stroke();
        if (first || d === Math.floor(this.cur)) this.month(date, x1 + 5, 15, "left");
        continue;
      }
      // ausserhalb: Wochenstriche (solange sie Platz haben), Monatsstriche mit Namen
      const monday = weekdayIndex(date) === 0;
      if (monday && w * 7 >= 16) {
        ctx.strokeStyle = past ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.2)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, axis - 3); ctx.lineTo(x1, axis + 4); ctx.stroke();
      }
      if (first) {
        ctx.strokeStyle = "rgba(255,255,255,.32)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x1, axis - 6); ctx.lineTo(x1, axis + 8); ctx.stroke();
        const label = date.getMonth() === 0 ? `${MON[0]} ${String(date.getFullYear()).slice(2)}` : MON[date.getMonth()];
        ctx.font = `500 10.5px ${FONT}`;
        const tw = ctx.measureText(label).width;
        if (x1 - tw / 2 > lastLabel + 8 && x1 > g.pad - 10 && x1 < W - g.pad + 10) {
          ctx.fillStyle = past ? colors.faint : colors.dim;
          ctx.fillText(label, x1, axis + 24);
          lastLabel = x1 + tw / 2;
        }
      }
    }
    // „heute“ als Strich, auch wenn der Fokus woanders liegt
    const xt = this.x(0, g);
    if (xt > g.pad - 20 && xt < W - g.pad + 20) {
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xt, axis - 14); ctx.lineTo(xt, axis + 14); ctx.stroke();
    }
  }

  private month(date: Date, x: number, y: number, align: CanvasTextAlign) {
    const { ctx, colors } = this;
    ctx.save();
    ctx.textAlign = align;
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = colors.dim;
    ctx.fillText(date.getMonth() === 0 ? `${MON[0]} ${date.getFullYear()}` : MON[date.getMonth()], x, y);
    ctx.restore();
  }

  // ----------------------------------------------------------------- Termine

  private node(ev: Ev) {
    const b = el("button", `ev k-${ev.kind}`);
    b.dataset.id = ev.id;
    b.append(ico(KIND_ICON[ev.kind]), el("span", "ev-t"));
    this.tint(b, ev);
    b.addEventListener("click", () => { if (ev.course != null) this.o.onOpen(ev.course); });
    b.addEventListener("pointerenter", () => this.showTip(ev, b));
    b.addEventListener("focus", () => this.showTip(ev, b));
    b.addEventListener("pointerleave", () => { this.tip.hidden = true; });
    b.addEventListener("blur", () => { this.tip.hidden = true; });
    this.layer.append(b);
    return b;
  }

  private tint(b: HTMLElement, ev: Ev) {
    const h = this.o.hueOf(ev.course);
    b.style.setProperty("--c", h == null ? "rgba(245,245,247,.8)" : hsl(h));
  }

  private place(g: Geom) {
    const today = todayDay();
    const lanes = new Map<number, number>(); // Tag -> belegte Reihen
    const extra = new Map<number, { x: number; n: number }>(); // Tag -> Termine, die nicht mehr in die Spalte passen
    const dotsAt: number[] = []; // x der Punkte ausserhalb des Fokus (fuer das Stapeln)
    const maxLanes = Math.max(1, Math.floor((this.axis - 14) / 24));
    const order = [...this.events].sort((a, b) => weight(b) - weight(a) || a.ts - b.ts);
    for (const ev of order) {
      const n = this.nodes.get(ev.id)!;
      const d = dayOfTs(ev.ts) - today;
      const x1 = this.x(d, g), x2 = this.x(d + 1, g);
      const w = x2 - x1;
      const important = ev.kind === "frist" || ev.kind === "pruefung";
      const daily = w >= DAILY;
      // nicht unter die Pfeilknoepfe an den Raendern laufen lassen
      let visible = x2 > g.pad + 4 && x1 < this.W - g.pad - 4 && (daily || important);
      n.classList.toggle("past", d < 0 && !ev.overdue);
      n.classList.toggle("dot", !daily);
      n.classList.toggle("over", ev.overdue);
      if (visible && daily) {
        const lane = lanes.get(d) ?? 0;
        if (lane >= maxLanes) { // Rest der Spalte: „+n“ auf dem Raster statt stilles Weglassen
          const e = extra.get(d) ?? { x: (x1 + x2) / 2, n: 0 };
          e.n++;
          extra.set(d, e);
          visible = false;
        } else {
          lanes.set(d, lane + 1);
          (n.lastElementChild as HTMLElement).textContent = important && w >= 64 ? shortTitle(ev.short) : "";
          n.style.width = `${Math.max(20, w - 6)}px`;
          n.style.transform = `translate(${x1 + 3}px, ${this.axis - 16 - (lane + 1) * 24}px)`;
          n.classList.toggle("lean", !important);
        }
      } else if (visible) {
        (n.lastElementChild as HTMLElement).textContent = "";
        n.style.width = "";
        const cx = (x1 + x2) / 2;
        const level = Math.min(3, dotsAt.filter((p) => Math.abs(p - cx) < 12).length);
        dotsAt.push(cx);
        n.style.transform = `translate(${cx - 8}px, ${this.axis - 24 - level * 15}px)`;
      }
      n.hidden = !visible;
    }
    const { ctx, colors } = this;
    ctx.font = `600 10.5px ${FONT}`;
    ctx.fillStyle = colors.dim;
    ctx.textAlign = "center";
    for (const e of extra.values()) ctx.fillText(`+${e.n}`, e.x, 10);
  }

  private showTip(ev: Ev, anchor: HTMLElement) {
    const t = this.tip;
    t.replaceChildren();
    const head = el("div", "tip-h");
    head.append(ico(KIND_ICON[ev.kind]), el("span", "", when(ev.ts, ev.allDay)));
    const name = this.o.nameOf(ev.course);
    t.append(head, el("p", "tip-t", ev.title));
    if (name) t.append(el("p", "tip-c", name));
    const h = this.o.hueOf(ev.course);
    t.style.setProperty("--c", h == null ? "rgba(245,245,247,.8)" : hsl(h));
    t.hidden = false;
    const a = anchor.getBoundingClientRect(), host = this.el.getBoundingClientRect();
    const left = clamp(a.left + a.width / 2 - host.left - t.offsetWidth / 2, 8, host.width - t.offsetWidth - 8);
    t.style.transform = `translate(${left}px, ${Math.max(6, a.top - host.top - t.offsetHeight - 8)}px)`;
  }
}

/** Reihenfolge in der Stapelung: Pruefungen und Fristen liegen der Achse am naechsten */
function weight(e: Ev) { return e.kind === "pruefung" ? 3 : e.kind === "frist" ? 2 : 1; }
