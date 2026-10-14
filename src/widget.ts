/**
 * Pomodoro-Widget (`index.html?widget=pomodoro`, eigenes Fenster von Rust: widget.rs): ohne Rahmen, durchsichtig, immer oben.
 * Es zeigt den Timer des Hauptfensters (Ereignis `pomodoro-state`, die Sekunden rechnet es selbst weiter) und schickt Pause,
 * Weiter, Ueberspringen und Stopp als `pomodoro-action` zurueck. Ziehen an einer beliebigen Stelle verschiebt es; die Lage wird
 * gemerkt. Meldet sich das Hauptfenster nicht, schliesst es sich wieder.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { el, ico, iconBtn } from "./ui";

export const WIDGET_POS = "kursbuch-widget";
type S = { phase: "focus" | "short" | "long"; status: "idle" | "running" | "paused" | "ready"; round: number; rounds: number; task: string; endAt: number; leftMs: number; total: number };

const R = 84;
const C = 2 * Math.PI * R;
const LABEL = { focus: "Fokus", short: "Pause", long: "Lange Pause" };
const mmss = (ms: number) => { const s = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export async function mountPomodoroWidget() {
  document.documentElement.classList.add("widget");
  document.body.classList.add("widget");
  const win = getCurrentWindow();
  let s: S | null = null;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.classList.add("fp-ring");
  const circle = () => document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const track = circle(), arc = circle();
  for (const c of [track, arc]) { c.setAttribute("cx", "100"); c.setAttribute("cy", "100"); c.setAttribute("r", String(R)); c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "7"); c.setAttribute("stroke-linecap", "round"); }
  track.classList.add("fp-track");
  arc.classList.add("fp-arc");
  arc.setAttribute("stroke-dasharray", String(C));
  arc.setAttribute("transform", "rotate(-90 100 100)");
  svg.append(track, arc);
  const time = el("div", "fp-time"), phase = el("div", "fp-phase"), sub = el("div", "fp-sub");
  const face = el("div", "fp-face");
  face.append(phase, time, sub);
  const dial = el("div", "fp-dial");
  dial.append(svg, face);

  const main = el("button", "fp-main n-glass n-liquid");
  const act = (a: string) => void emit("pomodoro-action", a);
  main.addEventListener("click", () => act(!s ? "start" : s.status === "running" ? "pause" : s.status === "paused" ? "resume" : "start"));
  const stop = iconBtn("stop", "Beenden", "n-ico n-glass n-liquid fp-side", () => act("stop"));
  const skip = iconBtn("next", "Phase überspringen", "n-ico n-glass n-liquid fp-side", () => act("skip"));
  const ctl = el("div", "fp-ctl");
  ctl.append(stop, main, skip);

  const root = el("div", "pw");
  root.dataset.tauriDragRegion = "";
  for (const e of [dial, face, svg, time, phase, sub]) e.dataset.tauriDragRegion = "";
  root.append(dial, ctl);
  document.body.append(root);

  const paint = () => {
    if (!s) return;
    const left = s.status === "running" ? Math.max(0, s.endAt - Date.now()) : s.leftMs;
    document.body.dataset.phase = s.phase;
    time.textContent = mmss(left);
    phase.textContent = LABEL[s.phase];
    sub.textContent = s.status === "ready" ? (s.phase === "focus" ? "weiter fokussieren" : "Pause starten") : s.status === "paused" ? "pausiert" : s.task || `Runde ${s.round} von ${s.rounds}`;
    arc.setAttribute("stroke-dashoffset", String(C * (1 - (s.total ? Math.min(1, left / s.total) : 1))));
    main.replaceChildren(ico(s.status === "running" ? "pause" : "play", 24));
    main.title = s.status === "running" ? "Pause" : s.status === "paused" ? "Weiter" : "Start";
    root.classList.toggle("ready", s.status === "ready");
  };

  await listen<S>("pomodoro-state", (e) => { s = e.payload; paint(); });
  window.setInterval(paint, 250);
  void emit("pomodoro-hello");
  // meldet sich das Hauptfenster nicht (z. B. beendet), gibt es nichts anzuzeigen
  window.setTimeout(() => { if (!s) void win.close(); }, 3000);

  // Lage merken (logische Pixel), gedrosselt
  let t = 0;
  void win.onMoved(({ payload }) => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      const f = await win.scaleFactor();
      try { localStorage.setItem(WIDGET_POS, JSON.stringify({ x: payload.x / f, y: payload.y / f })); } catch { /* egal */ }
    }, 300);
  });
}
