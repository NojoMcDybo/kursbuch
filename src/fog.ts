// Hintergrund: Nebel in den Farben der Kurse (Vorbild: Arena, src/fog.ts — hier kopiert und angepasst). Grosse weiche
// Schwaden ziehen langsam durchs Fenster; unter dem Liquid Glass bekommt dadurch alles Farbe und Tiefe, und die
// Brechung am Glasrand hat etwas zum Brechen. Gerechnet wird klein (1/10 der Fenstergroesse) und vom Browser weich
// hochskaliert: Radialverlaeufe sind ohnehin unscharf. „Bewegung reduzieren“ zeigt ein stehendes Bild.
// Wenige Bilder genuegen (die Bewegung ist sehr langsam) und sind wichtig: Jedes neue Nebelbild zwingt alle Glasflaechen
// darueber (backdrop-filter) zum Neuberechnen — gemessen kostet das bei 20 Bildern/s fast eine halbe CPU-Kern-Last
// im Leerlauf, bei 8 Bildern/s und angehalten ohne Fensterfokus nur einen Bruchteil.

const SCALE = 10;
const FPS = 8;

type Wisp = { color: [number, number, number]; dark: boolean; x: number; y: number; r: number; ax: number; ay: number; sx: number; sy: number; ph: number; a: number };

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0) as [number, number, number];
};

/** gleichmaessig gestreut (Goldener Winkel), aber jedes Mal gleich — der Nebel springt beim Neuaufbau nicht */
const spot = (i: number, n: number) => {
  const a = i * 2.399963;
  const d = Math.sqrt((i + 0.5) / Math.max(n, 1)) * 0.5;
  return [0.5 + Math.cos(a) * d * 1.1, 0.5 + Math.sin(a) * d * 0.9];
};

export class Fog {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wisps: Wisp[] = [];
  private sig = "";
  private timer = 0;
  private still = matchMedia("(prefers-reduced-motion: reduce)");

  constructor() {
    this.el = document.createElement("canvas");
    this.el.className = "fog";
    this.el.setAttribute("aria-hidden", "true");
    this.ctx = this.el.getContext("2d")!;
    const size = () => {
      this.el.width = Math.max(16, Math.ceil(innerWidth / SCALE));
      this.el.height = Math.max(10, Math.ceil(innerHeight / SCALE));
      this.draw(performance.now());
    };
    addEventListener("resize", size);
    document.addEventListener("visibilitychange", () => this.run());
    addEventListener("focus", () => this.run());
    addEventListener("blur", () => this.run());
    this.still.addEventListener("change", () => this.run());
    size();
  }

  /** Farben (Hex): `base` je zwei Schwaden, `accent` (die geoeffneten Kurse) je vier und kraeftiger; gleiche Farben -> nichts zu tun */
  setColors(base: string[], accent: string[] = []) {
    const acc = [...new Set(accent.map((c) => c.toLowerCase()))];
    const list = [...new Set([...acc, ...base.map((c) => c.toLowerCase())])];
    if (!list.length) list.push("#6f8cff");
    const sig = `${list.join(",")}|${acc.join(",")}`;
    if (sig === this.sig) return;
    this.sig = sig;
    // helle Schwaden (mehr fuer die betonten Farben), dazu dunkle (etwa jede dritte), die den Grund freilegen
    const bright = list.flatMap((c) => (acc.includes(c) ? [c, c, c, c] : [c, c]));
    const darkN = Math.max(2, Math.round(bright.length / 3));
    const n = bright.length + darkN;
    const order = [...bright.map((c) => ({ c, dark: false })), ...Array.from({ length: darkN }, () => ({ c: "#000000", dark: true }))];
    const mixed = order.map((o, i) => ({ o, k: (i * 7919) % n })).sort((a, b) => a.k - b.k).map((x) => x.o);
    this.wisps = mixed.map(({ c, dark }, i) => {
      const [x, y] = spot(i, n);
      const seed = (i * 0.6180339) % 1;
      return {
        color: rgb(c), dark, x, y,
        r: (dark ? 0.3 : 0.26) + seed * 0.16,
        ax: 0.12 + seed * 0.14, ay: 0.08 + ((seed * 3.3) % 1) * 0.12,
        sx: 0.018 + ((seed * 5.1) % 1) * 0.03, sy: 0.014 + ((seed * 7.7) % 1) * 0.026,
        ph: seed * Math.PI * 2,
        a: dark ? 0.8 : 0.5 + ((seed * 2.7) % 1) * 0.3,
      };
    }).sort((a, b) => Number(a.dark) - Number(b.dark)); // dunkle zuletzt: sie nehmen aus allem Farbe weg
    this.draw(performance.now());
    this.run();
  }

  /** Zeitgeber statt requestAnimationFrame: ein Animationsaufruf pro Bildschirmbild (hier 140 Hz) haelt die ganze Anzeige wach, auch wenn selten gezeichnet wird */
  private run() {
    clearInterval(this.timer);
    if (document.hidden || !document.hasFocus() || this.still.matches) return;
    this.timer = window.setInterval(() => this.draw(performance.now()), 1000 / FPS);
  }

  private draw(t: number) {
    const { ctx } = this;
    const w = this.el.width, h = this.el.height, big = Math.max(w, h);
    const s = t / 1000;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    for (const p of this.wisps) {
      // langsame Lissajous-Bahnen; Groesse und Dichte atmen leicht
      const x = (p.x + Math.sin(s * p.sx * 2 * Math.PI + p.ph) * p.ax) * w;
      const y = (p.y + Math.cos(s * p.sy * 2 * Math.PI + p.ph * 1.3) * p.ay) * h;
      const r = p.r * big * (1 + 0.12 * Math.sin(s * p.sy * 3 + p.ph));
      const a = p.a * (0.75 + 0.25 * Math.sin(s * p.sx * 4 + p.ph * 2));
      const [cr, cg, cb] = p.color;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      if (p.dark) {
        ctx.globalCompositeOperation = "destination-out";
        g.addColorStop(0, `rgba(0,0,0,${a})`);
        g.addColorStop(0.55, `rgba(0,0,0,${a * 0.45})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
      } else {
        // uebermalen statt aufhellen: jede Farbe behaelt ihren Ton, wo ihre Schwade dicht ist
        ctx.globalCompositeOperation = "source-over";
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
        g.addColorStop(0.45, `rgba(${cr},${cg},${cb},${a * 0.5})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
