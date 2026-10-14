/**
 * Fokus-Ansicht (die dunkle Flaeche ist heruntergefahren, es bleibt der farbige Verlauf): links To-do-Listen, in der Mitte der
 * Pomodoro-Timer, rechts der Lernstreak. Laeuft der Timer, steht er allein (body.pomo: alles andere ist weg; das Fenster darf
 * beliebig klein werden, scene.ts). Speichern: Listen und Einstellungen sofort (Rust: focus.rs), Sitzungen schreibt nur `log`.
 */

import { api, type FocusStats, type TodoList } from "./api";
import { dateOf } from "./dates";
import { type Phase, Pomodoro, ROUNDS } from "./pomodoro";
import { el, ico, iconBtn, menu, message, toast } from "./ui";

const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, "").slice(0, 20);
const mmss = (ms: number) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const LABEL: Record<Phase, string> = { focus: "Fokus", short: "Pause", long: "Lange Pause" };
const R = 84;
const C = 2 * Math.PI * R;

export class FocusScene {
  readonly el = el("section", "fc");
  private lists: TodoList[] = [];
  private stats: FocusStats | null = null;
  private active = "";
  private todo = el("article", "fcard ft n-glass n-liquid panel");
  private timer = el("article", "fcard fp n-glass n-liquid panel");
  private streak = el("article", "fcard fs n-glass n-liquid panel");
  private saveTimer = 0;
  /** Name einer Liste wird gerade eingegeben (neu oder umbenennen) */
  private naming: "new" | "rename" | null = null;
  readonly pomo: Pomodoro;
  // Teile des Timers, die sich jede Sekunde aendern
  private arc!: SVGCircleElement;
  private digits!: HTMLElement;
  private phase!: HTMLElement;
  private main!: HTMLButtonElement;
  private dots!: HTMLElement;
  private sub!: HTMLElement;

  constructor(onAlone: (on: boolean) => void) {
    this.pomo = new Pomodoro({ onLog: (m, t) => void this.log(m, t), onAlone });
    this.pomo.setSettings(this.pomo.focusMin, this.pomo.pauseMin);
    this.el.dataset.tauriDragRegion = "";
    this.buildTimer();
    this.el.append(this.todo, this.timer, this.streak);
    this.pomo.subscribe(() => this.paintTimer());
    void this.load();
  }

  async load() {
    try {
      const f = await api.focusGet();
      this.lists = f.lists;
      this.stats = f.stats;
      this.pomo.setSettings(f.settings.focus, f.settings.pause);
    } catch (e) {
      toast(message(e));
    }
    if (!this.lists.length) this.lists = [{ id: newId(), name: "Heute", items: [] }];
    if (!this.lists.some((l) => l.id === this.active)) this.active = this.lists[0].id;
    this.drawTodo();
    this.drawStreak();
    this.paintTimer();
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      api.focusSave(this.lists, { focus: this.pomo.focusMin, pause: this.pomo.pauseMin }).catch((e) => toast(message(e)));
    }, 250);
  }

  private async log(minutes: number, task: string) {
    try { this.stats = await api.focusLog(minutes, task); this.drawStreak(); } catch (e) { toast(message(e)); }
  }

  // ----------------------------------------------------------------- To-do

  private get list() { return this.lists.find((l) => l.id === this.active) ?? this.lists[0]; }

  private drawTodo() {
    const l = this.list;
    const tabs = el("div", "ft-tabs");
    if (this.naming) {
      const f = el("form", "ft-name");
      const input = el("input", "n-input");
      input.maxLength = 60;
      input.placeholder = "Name der Liste";
      input.value = this.naming === "rename" ? l.name : "";
      input.setAttribute("aria-label", "Name der Liste");
      const done = (ok: boolean) => {
        const name = input.value.trim();
        if (ok && name) {
          if (this.naming === "new") { const n = { id: newId(), name, items: [] }; this.lists.push(n); this.active = n.id; } else l.name = name;
          this.save();
        }
        this.naming = null;
        this.drawTodo();
      };
      f.addEventListener("submit", (e) => { e.preventDefault(); done(true); });
      input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } });
      f.append(input);
      tabs.append(f);
      queueMicrotask(() => input.focus());
    }
    else for (const x of this.lists) {
      const b = el("button", x.id === this.active ? "active" : "", x.name);
      b.setAttribute("aria-pressed", String(x.id === this.active));
      b.addEventListener("click", () => { this.active = x.id; this.drawTodo(); });
      tabs.append(b);
    }
    const plus = iconBtn("plus", "Neue Liste", "n-ico sm", () => { this.naming = "new"; this.drawTodo(); });
    const more = iconBtn("more", "Liste", "n-ico sm", () => menu(more, [
      { icon: "edit", label: "Umbenennen", run: () => { this.naming = "rename"; this.drawTodo(); } },
      { icon: "trash", label: "Liste löschen", run: () => this.removeList() },
    ]));
    const head = el("header", "ft-h");
    head.append(tabs, plus, more);

    const open = l.items.filter((t) => !t.done), done = l.items.filter((t) => t.done);
    const rows = [...open, ...done].map((t) => {
      const li = el("li", t.done ? "ft-i done" : "ft-i");
      const box = el("button", "ft-c");
      box.setAttribute("aria-label", t.done ? "Wieder offen" : "Erledigt");
      box.setAttribute("aria-pressed", String(t.done));
      box.append(ico("check"));
      box.addEventListener("click", () => { t.done = !t.done; this.save(); this.drawTodo(); });
      const text = el("span", "ft-t", t.text);
      const play = iconBtn("play", "Dafür den Timer starten", "n-ico sm ft-a", () => { this.pomo.setTask(t.text); if (this.pomo.status === "idle" || this.pomo.status === "ready") this.pomo.start(); });
      const del = iconBtn("trash", "Löschen", "n-ico sm ft-a", () => { l.items = l.items.filter((x) => x.id !== t.id); this.save(); this.drawTodo(); });
      li.append(box, text);
      if (!t.done) li.append(play);
      li.append(del);
      return li;
    });
    const form = el("form", "ft-add");
    const input = el("input", "n-input");
    input.placeholder = "Aufgabe hinzufügen";
    input.maxLength = 200;
    input.setAttribute("aria-label", "Neue Aufgabe");
    form.append(input);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      l.items.push({ id: newId(), text, done: false });
      this.save();
      this.drawTodo();
      this.todo.querySelector<HTMLInputElement>(".ft-add input")?.focus();
    });
    const count = el("p", "ft-n", l.items.length ? `${done.length} / ${l.items.length}` : "");
    this.todo.replaceChildren(head, count, el("ul", "ft-l", undefined), form);
    this.todo.querySelector(".ft-l")!.append(...rows);
  }

  private removeList() {
    if (this.lists.length === 1) { this.list.items = []; this.list.name = "Heute"; } else this.lists = this.lists.filter((l) => l.id !== this.active);
    this.active = this.lists[0].id;
    this.save();
    this.drawTodo();
  }

  // ----------------------------------------------------------------- Timer

  private buildTimer() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    svg.classList.add("fp-ring");
    const circle = () => document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const track = circle();
    const arc = circle();
    for (const c of [track, arc]) { c.setAttribute("cx", "100"); c.setAttribute("cy", "100"); c.setAttribute("r", String(R)); c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "7"); c.setAttribute("stroke-linecap", "round"); }
    track.classList.add("fp-track");
    arc.classList.add("fp-arc");
    arc.setAttribute("stroke-dasharray", String(C));
    arc.setAttribute("transform", "rotate(-90 100 100)");
    svg.append(track, arc);
    this.arc = arc;
    this.digits = el("div", "fp-time");
    this.phase = el("div", "fp-phase");
    this.sub = el("div", "fp-sub");
    const face = el("div", "fp-face");
    face.append(this.phase, this.digits, this.sub);
    const dial = el("div", "fp-dial");
    dial.append(svg, face);

    this.main = el("button", "fp-main n-glass n-liquid") as HTMLButtonElement;
    this.main.addEventListener("click", () => {
      const s = this.pomo.status;
      if (s === "running") this.pomo.pause(); else if (s === "paused") this.pomo.resume(); else this.pomo.start();
    });
    const stop = iconBtn("stop", "Beenden", "n-ico n-glass n-liquid fp-side", () => this.pomo.stop());
    const skip = iconBtn("next", "Phase überspringen", "n-ico n-glass n-liquid fp-side", () => this.pomo.skip());
    const ctl = el("div", "fp-ctl");
    ctl.append(stop, this.main, skip);
    this.dots = el("div", "fp-dots");
    const steps = el("div", "fp-steps");
    const step = (label: string, get: () => number, set: (n: number) => void) => {
      const w = el("div", "fp-step");
      const v = el("span", "fp-v");
      const upd = () => { v.textContent = `${get()} min`; };
      upd();
      w.append(el("small", "", label), iconBtn("min", `${label} kürzer`, "n-ico sm", () => { set(get() - 1); upd(); }), v, iconBtn("plus", `${label} länger`, "n-ico sm", () => { set(get() + 1); upd(); }));
      return w;
    };
    steps.append(
      step("Fokus", () => this.pomo.focusMin, (n) => { this.pomo.setSettings(n, this.pomo.pauseMin); this.save(); }),
      step("Pause", () => this.pomo.pauseMin, (n) => { this.pomo.setSettings(this.pomo.focusMin, n); this.save(); }),
    );
    this.timer.append(dial, ctl, this.dots, steps);
    this.timer.dataset.tauriDragRegion = "";
    dial.dataset.tauriDragRegion = "";
  }

  private paintTimer() {
    const p = this.pomo;
    const left = p.left;
    document.body.dataset.phase = p.status === "idle" ? "idle" : p.phase;
    this.digits.textContent = mmss(left);
    this.phase.textContent = LABEL[p.phase];
    this.arc.setAttribute("stroke-dashoffset", String(C * (1 - (p.total ? left / p.total : 1))));
    this.sub.textContent = p.status === "ready" ? (p.phase === "focus" ? "weiter fokussieren" : "Pause starten") : p.status === "paused" ? "pausiert" : p.task;
    this.main.replaceChildren(ico(p.status === "running" ? "pause" : "play", 26));
    this.main.title = p.status === "running" ? "Pause" : p.status === "paused" ? "Weiter" : "Start";
    this.main.setAttribute("aria-label", this.main.title);
    this.dots.replaceChildren(...Array.from({ length: ROUNDS }, (_, i) => el("i", i < (p.phase === "focus" ? p.round - 1 : p.round) ? "on" : i === p.round - 1 && p.phase === "focus" && p.status !== "idle" ? "now" : "")));
    this.timer.classList.toggle("idle", p.status === "idle");
    this.timer.classList.toggle("ready", p.status === "ready");
  }

  // ----------------------------------------------------------------- Streak

  private drawStreak() {
    const st = this.stats;
    if (!st) return;
    const head = el("div", "fs-h");
    const big = el("div", "fs-big");
    big.append(el("b", "", String(st.current)), el("span", "", st.current === 1 ? "Tag" : "Tage"));
    head.append(el("h3", "", "Lernstreak"), big);
    const facts = el("ul", "fs-f");
    const fact = (k: string, v: string) => { const li = el("li"); li.append(el("span", "", k), el("b", "", v)); facts.append(li); };
    fact("Heute", st.today ? `${st.today} × · ${st.today_minutes} min` : "–");
    fact("Beste Reihe", `${st.best} ${st.best === 1 ? "Tag" : "Tage"}`);
    fact("Gesamt", `${st.total} Fokusphasen`);
    // Raster der letzten 12 Wochen: Spalte = Woche (Montag oben), Farbe = Anzahl
    const by = new Map(st.days);
    const t = st.today_day;
    const wd = (d: number) => (dateOf(d).getDay() + 6) % 7;
    const monday = t - wd(t) - 11 * 7;
    const grid = el("div", "fs-grid");
    for (let i = 0; i < 12 * 7; i++) {
      const d = monday + Math.floor(i / 7) * 7 + (i % 7);
      const n = by.get(d) ?? 0;
      const c = el("i", d > t ? "fut" : n >= 4 ? "l3" : n >= 2 ? "l2" : n >= 1 ? "l1" : "");
      c.style.gridColumn = String(Math.floor(i / 7) + 1);
      c.style.gridRow = String((i % 7) + 1);
      if (d <= t) c.title = `${dateOf(d).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" })}${n ? ` · ${n} Fokusphasen` : ""}`;
      grid.append(c);
    }
    this.streak.replaceChildren(head, facts, grid);
  }
}
