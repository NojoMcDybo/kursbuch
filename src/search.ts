/**
 * Suche in allen Inhalten (Strg+K): Namen von Kursen, Abschnitten und Aktivitaeten und der Text aller Dateien
 * (PDF, DOCX, PPTX) mit Seitenzahl. Das Fenster oeffnet sich aus der Lupe in die Mitte (Liquid Glass) und schliesst sich in sie. „Schnell“ sucht beim Tippen (alle Woerter muessen vorkommen); „Tief“ erst nach Enter und
 * weiter gefasst (Wortstaemme, ein Wort genuegt, Dokumente nach Dichte; die KI-Neubewertung folgt spaeter). Treffer sind
 * nach Kurs gruppiert; Pfeile und Enter oeffnen, die Knoepfe rechts kopieren die Datei oder zeigen sie im Kurs.
 */

import { api, type Found, type Hit, type HitKind } from "./api";
import type { IconName } from "./nojo/nojo-ui";
import { act, copyText, el, hsl, ico, iconBtn, menu, message, morph, num, toast } from "./ui";

const KEY = "kursbuch-search";
const OPEN = String.fromCharCode(1);
const CLOSE = String.fromCharCode(2);
const KIND_ICON: Record<HitKind, IconName> = { course: "kursbuch", section: "layout", activity: "open", pdf: "document", docx: "document", pptx: "document" };
const KIND_LABEL: Record<HitKind, string> = { course: "Kurs", section: "Abschnitt", activity: "Aktivität", pdf: "PDF", docx: "Word", pptx: "Folien" };
const isFile = (k: HitKind) => k === "pdf" || k === "docx" || k === "pptx";

export type SearchOpts = {
  hueOf: (course: number | null) => number | null;
  nameOf: (course: number | null) => string;
  /** Kurse des gewaehlten Semesters und sein kurzer Name */
  semesterIds: () => number[];
  semesterLabel: () => string;
  /** Kurs in seinem Fenster oeffnen und eine Aktivitaet oder einen Abschnitt zeigen */
  reveal: (course: number, target?: { cmid?: number; section?: string }) => Promise<unknown>;
  /** die Lupe, aus der sich das Fenster oeffnet (und in die es sich schliesst) */
  anchor: () => HTMLElement | null;
  /** Fenster geoeffnet/geschlossen (der Nebel ruht dann) */
  onToggle?: (open: boolean) => void;
};

/** Zeichen ohne Akzent, klein, ß als ss (wie der Index) */
const fold = (c: string) => c.toLowerCase().replace("ß", "ss").normalize("NFD").replace(/\p{M}/gu, "");

/** Text mit hervorgehobenen Wortanfaengen der Suchwoerter (`words` sind schon gefaltet) */
export function highlight(text: string, words: string[]): DocumentFragment {
  let folded = "";
  const map: number[] = []; // Stelle im Original zu jedem Zeichen des gefalteten Textes
  let pos = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) map.push(pos);
    folded += f;
    pos += ch.length;
  }
  map.push(text.length);
  const ranges: [number, number][] = [];
  for (const w of words) {
    if (!w) continue;
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + w.length)) {
      if (i === 0 || !/[\p{L}\p{N}]/u.test(folded[i - 1])) ranges.push([map[i], map[i + w.length]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) frag.append(text.slice(at, a));
    frag.append(el("mark", "", text.slice(a, b)));
    at = b;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}

/** Ausschnitt aus der Datenbank: Treffer stehen zwischen OPEN und CLOSE */
function snippet(s: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let on = false;
  for (const part of s.split(new RegExp(`(${OPEN}|${CLOSE})`))) {
    if (part === OPEN) on = true;
    else if (part === CLOSE) on = false;
    else if (part) frag.append(on ? el("mark", "", part) : part);
  }
  return frag;
}

/** Treffer als Markdown fuer Claude/ChatGPT */
export function resultsText(query: string, f: Found, deep: boolean, nameOf: (course: number) => string): string {
  const out = [`# LearnWeb-Suche: „${query}“${deep ? " (tiefe Suche)" : ""}`, "", `${f.hits.length} Treffer. Pfade sind relativ zum LearnWeb-Ordner; Treffer im Text sind **fett**.`, ""];
  f.hits.forEach((h, i) => {
    const pages = h.pages.length ? `, S. ${h.pages.join(", ")}` : "";
    out.push(`${i + 1}. [${nameOf(h.course)}] ${h.title} (${KIND_LABEL[h.kind]}${pages})${h.path ? ` – ${h.path}` : ""}`);
    const s = h.snippet.split(OPEN).join("**").split(CLOSE).join("**").replace(/\s+/g, " ").trim();
    if (s) out.push(`   „${s}“`);
  });
  return out.join("\n") + "\n";
}

export class Search {
  readonly el = el("div", "sx");
  private input = el("input", "sx-in");
  private list = el("div", "sx-list");
  private status = el("span", "sx-status");
  private modeSeg = el("nav", "n-seg sx-seg");
  private scopeSeg = el("nav", "n-seg sx-seg");
  private deep = false;
  private all = false;
  private seq = 0;
  private timer = 0;
  private found: Found | null = null;
  private asked = "";
  private rows: HTMLElement[] = [];
  private sel = -1;
  private back: HTMLElement | null = null;
  private panel = el("div", "sx-panel n-glass n-liquid panel");
  private shade = el("div", "sx-back");
  private closing = false;
  /** Mauszeiger und Mauslicht sind weg, solange man tippt; eine echte Mausbewegung (ab 6 px) holt sie zurueck */
  private pos: [number, number] | null = null;

  constructor(private o: SearchOpts) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      this.deep = !!s.deep;
      this.all = !!s.all;
    } catch { /* egal */ }
    this.el.hidden = true;
    this.input.type = "text";
    this.input.placeholder = "Suchen …";
    this.input.setAttribute("aria-label", "Suche in allen Inhalten");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    const bar = el("div", "sx-bar");
    const field = el("label", "sx-field");
    field.append(ico("search"), this.input);
    bar.append(field, this.modeSeg, this.scopeSeg, iconBtn("close", "Schließen (Esc)", "n-ico sm", () => this.close()));
    const foot = el("div", "sx-foot");
    const ai = iconBtn("spark", "Für KI kopieren", "n-ico sm", () => this.aiMenu(ai));
    foot.append(this.status, ai);
    const panel = this.panel;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Suche");
    panel.append(bar, this.list, foot);
    this.shade.addEventListener("pointerdown", () => this.close());
    this.el.append(this.shade, panel);
    this.drawSegs();
    this.el.addEventListener("pointermove", (e) => this.nudge(e));
    this.el.addEventListener("keydown", () => this.quiet(true), true);
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); this.close(); } });
    this.empty();
  }

  get isOpen() { return !this.el.hidden; }

  private quiet(on: boolean) {
    this.el.classList.toggle("quiet", on);
    if (on) this.pos = null;
  }

  private nudge(e: PointerEvent) {
    if (!this.el.classList.contains("quiet")) return;
    if (!this.pos) { this.pos = [e.clientX, e.clientY]; return; } // erste Meldung (auch vom Layout ausgeloest): nur merken
    if (Math.hypot(e.clientX - this.pos[0], e.clientY - this.pos[1]) >= 6) this.quiet(false);
  }

  private get kids() { return [...this.panel.children] as HTMLElement[]; }

  open(term?: string) {
    const fresh = !this.isOpen || this.closing;
    if (!this.isOpen) this.back = document.activeElement as HTMLElement | null;
    this.closing = false;
    this.el.hidden = false;
    this.drawSegs();
    if (fresh) {
      this.quiet(true); // beim Aufgehen verschwindet der Mauszeiger, damit der Text frei lesbar bleibt
      this.o.onToggle?.(true);
      this.shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
      void morph(this.panel, this.o.anchor()?.getBoundingClientRect() ?? null, this.kids, true);
    }
    if (term != null) {
      this.input.value = term;
      this.deep = false; // von aussen (Deep Link, Notch): schnell, sofort
      this.drawSegs();
      this.run();
    }
    this.input.focus();
    this.input.select();
  }

  close() {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    clearTimeout(this.timer);
    this.seq++;
    this.shade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-in", fill: "forwards" });
    void morph(this.panel, this.o.anchor()?.getBoundingClientRect() ?? null, this.kids, false).then(() => {
      if (!this.closing) return; // zwischendurch wieder geoeffnet
      this.closing = false;
      this.el.hidden = true;
      this.o.onToggle?.(false);
      this.back?.focus?.();
      this.back = null;
    });
  }

  // ----------------------------------------------------------------- Bedienung

  private save() { try { localStorage.setItem(KEY, JSON.stringify({ deep: this.deep, all: this.all })); } catch { /* egal */ } }

  private seg(host: HTMLElement, items: [string, string, boolean, () => void][]) {
    host.replaceChildren(...items.map(([label, title, on, run]) => {
      const b = el("button", on ? "active" : "", label);
      b.title = title;
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => { run(); this.save(); this.drawSegs(); if (this.input.value.trim()) this.run(); this.input.focus(); });
      return b;
    }));
  }

  private drawSegs() {
    this.seg(this.modeSeg, [
      ["Schnell", "Beim Tippen, alle Wörter", !this.deep, () => { this.deep = false; }],
      ["Tief", "Erst mit Enter; Wortformen, ein Wort genügt, nach Dichte", this.deep, () => { this.deep = true; }],
    ]);
    this.seg(this.scopeSeg, [
      [this.o.semesterLabel() || "Semester", "Nur Kurse dieses Semesters", !this.all, () => { this.all = false; }],
      ["Alle", "Alle Kurse", this.all, () => { this.all = true; }],
    ]);
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.input.value.trim()) { this.seq++; this.found = null; this.empty(); return; }
    if (this.deep) return; // tief sucht erst mit Enter
    this.timer = window.setTimeout(() => this.run(), 130);
  }

  private key(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (this.rows.length) this.select((this.sel + (e.key === "ArrowDown" ? 1 : -1) + this.rows.length) % this.rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const stale = this.deep && this.asked !== this.query() + "|deep";
      if (stale || this.sel < 0) { if (this.input.value.trim()) this.run(); } else this.rows[this.sel]?.querySelector<HTMLElement>(".sx-main")?.click();
    }
  }

  private select(i: number) {
    this.rows[this.sel]?.classList.remove("sel");
    this.sel = i;
    const r = this.rows[i];
    if (!r) return;
    r.classList.add("sel");
    r.scrollIntoView({ block: "nearest" });
  }

  private query() { return this.input.value.trim(); }
  private scope() { return this.all ? [] : this.o.semesterIds(); }

  // ----------------------------------------------------------------- Suchen und Zeigen

  private async run() {
    clearTimeout(this.timer);
    const text = this.query();
    if (!text) { this.empty(); return; }
    const seq = ++this.seq;
    this.list.classList.add("busy");
    try {
      const f = await api.search(text, this.deep, this.scope());
      if (seq !== this.seq) return;
      this.found = f;
      this.asked = text + (this.deep ? "|deep" : "");
      this.show(f);
    } catch (e) {
      if (seq === this.seq) { this.found = null; this.notice("refresh", message(e)); }
    } finally {
      if (seq === this.seq) this.list.classList.remove("busy");
    }
  }

  private empty() {
    this.rows = [];
    this.sel = -1;
    this.status.textContent = "";
    const d = el("div", "sx-note");
    d.append(ico("search", 34));
    const hint = el("div", "sx-keys");
    for (const k of ["↑↓", "↵", "Esc"]) hint.append(el("kbd", "", k));
    d.append(hint);
    this.list.replaceChildren(d);
  }

  private notice(icon: IconName, text: string, action?: [string, () => void]) {
    this.rows = [];
    this.sel = -1;
    const d = el("div", "sx-note");
    d.append(ico(icon, 34), el("p", "", text));
    if (action) {
      const b = el("button", "n-btn", action[0]);
      b.addEventListener("click", action[1]);
      d.append(b);
    }
    this.list.replaceChildren(d);
  }

  private show(f: Found) {
    this.status.textContent = f.indexed ? `${num(f.hits.length)} · ${f.ms} ms` : "";
    if (!f.indexed) { this.notice("refresh", "Noch kein Suchindex (erst nach dem ersten Sync)."); return; }
    if (!f.hits.length) {
      this.notice("search", "Nichts gefunden", !this.all ? ["Alle Kurse", () => { this.all = true; this.save(); this.drawSegs(); void this.run(); }] : undefined);
      return;
    }
    const words = f.words.map((w) => [...w].map(fold).join(""));
    // nach Kurs gruppiert; die Gruppen stehen in der Reihenfolge ihres besten Treffers
    const groups = new Map<number, Hit[]>();
    for (const h of f.hits) groups.set(h.course, [...(groups.get(h.course) ?? []), h]);
    const out: HTMLElement[] = [];
    this.rows = [];
    for (const [course, hits] of groups) {
      const g = el("section", "sx-g");
      const hue = this.o.hueOf(course);
      if (hue != null) g.style.setProperty("--c", hsl(hue));
      const head = el("h3", "sx-gh");
      head.append(el("i", "sx-dot"), el("span", "", this.o.nameOf(course) || `Kurs ${course}`), el("small", "", String(hits.length)));
      g.append(head);
      for (const h of hits) { const r = this.row(h, words); this.rows.push(r); g.append(r); }
      out.push(g);
    }
    this.list.replaceChildren(...out);
    this.list.scrollTop = 0;
    this.sel = -1;
    this.select(0);
  }

  private row(h: Hit, words: string[]) {
    const r = el("div", "sx-row");
    const main = el("button", "sx-main");
    const body = el("div", "sx-body");
    const t = el("div", "sx-t");
    t.append(highlight(h.title, words));
    body.append(t);
    if (h.snippet) { const s = el("div", "sx-s"); s.append(snippet(h.snippet)); body.append(s); }
    const meta = el("div", "sx-m");
    if (h.pages.length) meta.append(el("span", "sx-p", `S. ${h.pages.join(" · ")}${h.count > h.pages.length ? " …" : ""}`));
    meta.append(el("span", "sx-k", isFile(h.kind) ? h.kind.toUpperCase() : KIND_LABEL[h.kind]));
    main.append(ico(KIND_ICON[h.kind]), body, meta);
    main.addEventListener("click", () => this.pick(h));
    main.addEventListener("pointermove", () => { const i = this.rows.indexOf(r); if (i !== this.sel) this.select(i); });
    r.append(main);
    if (isFile(h.kind) || h.kind === "activity" || h.kind === "section") {
      const a = el("div", "sx-acts");
      if (isFile(h.kind) && h.file != null && h.cmid != null) {
        const idx = h.file, cmid = h.cmid;
        a.append(iconBtn("copy", "Datei kopieren", "n-ico sm", () => act(api.copyFile(h.course, cmid, idx).then(() => toast("Kopiert")))));
      }
      if (isFile(h.kind)) a.append(iconBtn("layout", "Im Kurs zeigen", "n-ico sm", () => { this.close(); void this.o.reveal(h.course, h.cmid != null ? { cmid: h.cmid } : undefined); }));
      if (a.childElementCount) { r.append(a); r.classList.add("has-acts"); }
    }
    return r;
  }

  /** Treffer oeffnen: Datei im passenden Programm, alles andere im Kurs zeigen */
  private pick(h: Hit) {
    this.close();
    if (isFile(h.kind) && h.file != null && h.cmid != null) { act(api.openFile(h.course, h.cmid, h.file)); return; }
    const target = h.kind === "section" ? { section: h.title } : h.cmid != null ? { cmid: h.cmid } : undefined;
    void this.o.reveal(h.course, target);
  }

  // ----------------------------------------------------------------- Fuer KI

  private aiMenu(anchor: HTMLElement) {
    const text = this.query();
    const found = this.found;
    menu(anchor, [
      ...(found?.hits.length ? [{ icon: "spark" as IconName, label: "Treffer", hint: `${found.hits.length} mit Ausschnitt und Pfad`, run: () => this.copy(resultsText(text, found, this.deep, (c) => this.o.nameOf(c))) }] : []),
      { icon: "document", label: "Verzeichnis", hint: "alle Kurse und Dateien", run: () => void api.forAi(null, false).then((o) => this.copy(o.text)).catch((e) => toast(message(e))) },
      { icon: "open", label: "Verzeichnis in Obsidian", run: () => act(api.openDirectory()) },
    ]);
  }

  private copy(text: string) {
    copyText(text).then(() => toast(`Kopiert · ${num(text.length)} Zeichen`)).catch((e) => toast(message(e)));
  }
}

/** Fuer main.ts: Strg+K oeffnet die Suche */
export const isSearchKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
