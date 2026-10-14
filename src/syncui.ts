/**
 * Sync aus der App (Rust: sync.rs, Python: learnweb sync --json): Knopf in der Leiste mit Fortschritt und die Fortschrittskarte
 * auf dem Anmeldebild. Nach der Anmeldung soll alles von selbst gesucht, geladen und eingeordnet werden: Kurse, Inhalte, Termine,
 * Wochenplan, Suche. Die Python-Seite ruft LearnWeb mit Pausen ab; hier wird nur angezeigt, was sie meldet.
 */

import { listen } from "@tauri-apps/api/event";
import { api, type SyncEvent } from "./api";
import { el, ico, message } from "./ui";

export type SyncState = {
  running: boolean;
  /** 0..1 */
  progress: number;
  /** was gerade geschieht */
  step: string;
  /** Kurs, der gerade geladen wird */
  course: string;
  index: number;
  total: number;
  error: string | null;
  code: string | null;
};

const idle = (): SyncState => ({ running: false, progress: 0, step: "", course: "", index: 0, total: 0, error: null, code: null });
/** Schritte nach den Kursen in der Reihenfolge der Python-Seite; jedes Ereignis meldet einen fertigen Schritt */
const AFTER: Record<string, [string, number]> = {
  content: ["Termine ordnen", 0.8], events: ["Wochenplan erkennen", 0.86], schedule: ["Suche aufbauen", 0.92], index: ["Verzeichnis schreiben", 0.96],
};

export class SyncUi {
  state: SyncState = idle();
  private subs = new Set<() => void>();

  /** `onEnd(ok)` nach jedem Lauf (auch bei Fehler); die Ansicht holt dann den neuen Stand */
  constructor(private onEnd: (ok: boolean, state: SyncState) => void) {
    void listen<SyncEvent>("sync-event", (e) => this.on(e.payload));
    void api.syncRunning().then((r) => { if (r) this.set({ running: true, step: "Synchronisiere …" }); }).catch(() => {});
  }

  subscribe(fn: () => void) { this.subs.add(fn); return () => this.subs.delete(fn); }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((f) => f());
  }

  /** Sync starten; `false`, wenn schon einer laeuft (dann wird dessen Fortschritt weiter gezeigt) */
  async start(): Promise<boolean> {
    if (this.state.running) return false;
    this.state = { ...idle(), running: true, step: "Verbinde mit LearnWeb …" };
    this.subs.forEach((f) => f());
    try {
      const started = await api.syncStart();
      if (!started) this.set({ step: "Ein Sync läuft bereits …" });
      return started;
    } catch (e) {
      this.set({ running: false, error: message(e) });
      this.onEnd(false, this.state);
      return false;
    }
  }

  private on(e: SyncEvent) {
    switch (e.event) {
      case "begin": this.state = { ...idle(), running: true, step: "Verbinde mit LearnWeb …" }; this.subs.forEach((f) => f()); break;
      case "start": this.set({ total: e.courses ?? 0, step: e.courses ? "Kurse werden geladen" : "Keine Kurse gefunden", progress: 0.04 }); break;
      case "course": {
        const total = e.total ?? this.state.total, index = e.index ?? this.state.index;
        this.set({ index, total, course: e.name ?? "", step: index >= total ? "Inhalte der Kurse lesen" : "Kurse werden geladen", progress: 0.04 + (total ? (index / total) * 0.7 : 0) });
        break;
      }
      case "error": this.set({ error: e.message ?? "Der Sync ist fehlgeschlagen.", code: e.code == null ? null : String(e.code) }); break;
      case "done": this.set({ progress: 1, step: "Fertig", course: "" }); break;
      case "end": {
        const ok = !this.state.error;
        this.set({ running: false });
        this.onEnd(ok, this.state);
        break;
      }
      default: {
        const next = AFTER[e.event];
        if (next) this.set({ step: next[0], progress: next[1], course: "" });
      }
    }
  }

  /** Knopf in der Leiste: dreht sich waehrend des Syncs, der Tooltip nennt den Fortschritt */
  bind(btn: HTMLButtonElement) {
    const paint = () => {
      const s = this.state;
      btn.classList.toggle("busy", s.running);
      btn.setAttribute("aria-busy", String(s.running));
      btn.style.setProperty("--p", String(s.progress));
      btn.title = s.running ? `${s.step}${s.total && s.index ? ` · Kurs ${s.index} von ${s.total}` : ""}${s.course ? `\n${s.course}` : ""}` : "Mit LearnWeb abgleichen";
    };
    this.subscribe(paint);
    paint();
    btn.addEventListener("click", () => { if (!this.state.running) void this.start(); });
  }

  /** Fortschrittskarte (Anmeldebild): Schritt, Kurs, Balken; bei Fehler mit „Nochmal“ und „Trotzdem öffnen“ */
  card(retry: () => void, skip: () => void): HTMLElement {
    const box = el("div", "sp");
    const head = el("div", "sp-h"), title = el("b"), fill = el("i"), bar = el("div", "sp-bar");
    const line = el("p", "sp-s"), sub = el("p", "sp-c"), row = el("div", "sp-a");
    bar.append(fill);
    bar.setAttribute("role", "progressbar");
    const again = el("button", "n-btn primary", "Nochmal versuchen"), open = el("button", "n-btn", "Trotzdem öffnen");
    again.addEventListener("click", retry);
    open.addEventListener("click", skip);
    row.append(again, open);
    const wheel = ico("refresh", 20), cross = ico("close", 20);
    box.append(head, bar, line, sub, row);
    const paint = () => {
      const s = this.state;
      box.classList.toggle("err", !!s.error);
      head.replaceChildren(s.error ? cross : wheel, title);
      title.textContent = s.error ? "Das hat nicht geklappt" : "Kurse werden gesucht";
      fill.style.width = `${Math.round(Math.max(0.03, s.progress) * 100)}%`;
      bar.setAttribute("aria-valuenow", String(Math.round(s.progress * 100)));
      line.textContent = s.error ?? (s.step || "Einen Moment …");
      sub.textContent = s.error ? "" : s.course || (s.total ? `${s.total} Kurse` : "Kursbuch ordnet alles von selbst ein.");
      again.disabled = s.running;
      row.hidden = !s.error;
    };
    this.subscribe(paint);
    paint();
    return box;
  }
}
