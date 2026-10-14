/**
 * Pomodoro: Fokus (25 min), kurze Pause (5 min), nach vier Runden eine lange (das Dreifache). Am Ende einer Phase haelt nichts
 * an und nichts startet von selbst: der Timer zeigt die naechste Phase als „bereit“ und wartet auf den Start. Nur abgeschlossene
 * Fokusphasen zaehlen (fuer den Lernstreak); ein Abbruch oder Ueberspringen nicht. Der Stand ueberlebt ein Neuladen
 * (localStorage). Die Notch zeigt dazu eine eigene Karte (Rust: pomodoro.rs); ihre Knoepfe kommen als `pomodoro-action` zurueck.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { api, type PomoNotch } from "./api";

export type Phase = "focus" | "short" | "long";
export type Status = "idle" | "running" | "paused" | "ready";

const KEY = "kursbuch-pomo";
export const ROUNDS = 4;

export type PomoOpts = {
  /** abgeschlossene Fokusphase (Minuten, Aufgabe) */
  onLog: (minutes: number, task: string) => void;
  /** Allein-Ansicht noetig (laeuft, pausiert oder bereit) bzw. wieder vorbei */
  onAlone: (on: boolean) => void;
};

export class Pomodoro {
  phase: Phase = "focus";
  status: Status = "idle";
  round = 1;
  task = "";
  focusMin = 25;
  pauseMin = 5;
  private endAt = 0;
  private leftMs = 0;
  private timer = 0;
  private subs = new Set<() => void>();

  constructor(private o: PomoOpts) {
    this.restore();
    void listen<string>("pomodoro-action", (e) => {
      if (e.payload === "pause") this.pause();
      else if (e.payload === "resume") this.resume();
      else if (e.payload === "start") this.start();
      else if (e.payload === "stop") this.stop();
      else if (e.payload === "skip") this.skip();
    });
    void listen("pomodoro-hello", () => this.broadcast()); // das Widget fragt nach dem Stand, sobald es offen ist
  }

  /** bei jeder Aenderung und (laufend) mehrmals je Sekunde */
  subscribe(fn: () => void) { this.subs.add(fn); return () => this.subs.delete(fn); }

  get total(): number { return (this.phase === "focus" ? this.focusMin : this.phase === "short" ? this.pauseMin : this.pauseMin * 3) * 60_000; }
  /** verbleibende Zeit in ms */
  get left(): number { return this.status === "running" ? Math.max(0, this.endAt - Date.now()) : this.status === "idle" ? this.total : this.leftMs; }
  get active() { return this.status !== "idle"; }

  setSettings(focus: number, pause: number) {
    this.focusMin = Math.min(180, Math.max(1, Math.round(focus)));
    this.pauseMin = Math.min(60, Math.max(1, Math.round(pause)));
    if (this.status === "idle" || this.status === "ready") this.leftMs = this.total;
    this.changed(false);
  }

  setTask(t: string) { this.task = t.slice(0, 200); this.changed(); }

  start() {
    if (this.status === "running") return;
    if (this.status === "idle") { this.phase = "focus"; this.round = 1; this.leftMs = this.total; }
    this.run(this.status === "paused" ? this.leftMs : this.leftMs || this.total);
    this.o.onAlone(true);
  }

  pause() {
    if (this.status !== "running") return;
    this.leftMs = this.left;
    this.status = "paused";
    this.changed();
  }

  resume() { if (this.status === "paused") this.run(this.leftMs); }

  stop() {
    this.status = "idle";
    this.phase = "focus";
    this.round = 1;
    this.leftMs = 0;
    this.changed();
    this.o.onAlone(false);
  }

  /** Phase beenden und zur naechsten (bereit); eine uebersprungene Fokusphase zaehlt nicht */
  skip() { if (this.active) this.finish(false); }

  private run(ms: number) {
    this.endAt = Date.now() + ms;
    this.status = "running";
    this.changed();
  }

  private finish(logIt: boolean) {
    const was = this.phase;
    if (was === "focus" && logIt) this.o.onLog(this.focusMin, this.task);
    if (was === "focus") this.phase = this.round % ROUNDS === 0 ? "long" : "short";
    else { this.phase = "focus"; this.round = was === "long" ? 1 : this.round + 1; }
    this.status = "ready";
    this.leftMs = this.total;
    if (logIt) chime();
    this.changed();
  }

  private changed(notify = true) {
    clearInterval(this.timer);
    if (this.status === "running") this.timer = window.setInterval(() => this.tick(), 250);
    try { localStorage.setItem(KEY, JSON.stringify({ phase: this.phase, status: this.status, round: this.round, task: this.task, endAt: this.endAt, leftMs: this.leftMs, focusMin: this.focusMin, pauseMin: this.pauseMin })); } catch { /* egal */ }
    if (notify) this.notch();
    this.broadcast();
    this.subs.forEach((f) => f());
  }

  private tick() {
    if (this.status === "running" && Date.now() >= this.endAt) this.finish(true);
    else this.subs.forEach((f) => f());
  }

  /** Stand an das Widget-Fenster (es rechnet die Sekunden selbst weiter) */
  private broadcast() {
    void emit("pomodoro-state", { phase: this.phase, status: this.status, round: this.round, rounds: ROUNDS, task: this.task, endAt: this.endAt, leftMs: this.leftMs, total: this.total });
  }

  private notch() {
    const s: PomoNotch | null = this.status === "idle" ? null : {
      phase: this.phase, status: this.status, ends_at: this.status === "running" ? this.endAt : 0, left: Math.ceil(this.left / 1000),
      total: Math.round(this.total / 1000), task: this.task, round: this.round, rounds: ROUNDS,
    };
    void api.pomodoroNotch(s).catch(() => {});
  }

  private restore() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (!s) return;
      this.focusMin = s.focusMin ?? 25;
      this.pauseMin = s.pauseMin ?? 5;
      if (s.status === "idle") return;
      this.phase = s.phase;
      this.round = s.round;
      this.task = s.task ?? "";
      this.endAt = s.endAt ?? 0;
      this.leftMs = s.leftMs ?? this.total;
      this.status = s.status;
      if (this.status === "running" && this.endAt <= Date.now()) { // waehrend die App zu war abgelaufen: nichts nachtraeglich zaehlen
        this.finish(false);
      } else {
        this.changed();
      }
      this.o.onAlone(true);
    } catch { /* egal */ }
  }
}

/** Weicher Dreiklang am Ende einer Phase (WebAudio, kein Ton ohne vorherige Eingabe im Fenster) */
function chime() {
  try {
    const ctx = new AudioContext();
    [659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 1.2);
    });
    window.setTimeout(() => void ctx.close(), 2500);
  } catch { /* egal */ }
}
