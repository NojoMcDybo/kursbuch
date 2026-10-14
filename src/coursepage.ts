/**
 * Kursseite im eigenen Fenster: Kopf mit Aktionen (Fuer KI kopieren, LearnWeb, Notiz, Ordner), darunter die Abschnitte als
 * fortlaufende Seite ohne Karten. Zeilen: Datei oeffnen, kopieren, laden; „zu gross“ laedt ein Klick trotzdem. Aktivitaeten, die
 * seit dem letzten Oeffnen neu oder aktualisiert sind, tragen einen Punkt.
 */

import { api, type CourseView, type Extras, type FetchError, type ItemView, type News } from "./api";
import { left, urgency } from "./dates";
import { lightScroller, type IconName } from "./nojo/nojo-ui";
import { act, copyText, el, ico, iconBtn, menu, message, num, toast, typeIcon } from "./ui";

/** Stelle, die die Seite zeigen soll: eine Aktivitaet oder ein Abschnitt (nach Titel) */
export type Target = { cmid?: number | null; section?: string | null };

export class CoursePage {
  readonly el = el("article", "cp");
  private head = el("header", "p-head");
  private side = el("aside", "p-side");
  private extras: Extras | null = null;
  private allNews = false;
  private body = el("div", "p-body");
  private view: CourseView | null = null;
  private sig = "";
  private fresh = new Set<number>();
  /** laufende Sofort-Downloads (cmid) */
  private busy = new Set<number>();

  constructor(readonly id: number, private onView: (v: CourseView) => void) {
    this.head.dataset.tauriDragRegion = "";
    this.el.append(this.head, this.body, this.side);
    this.el.style.setProperty("--h", "215");
  }

  /** Stand holen; neu gezeichnet wird nur bei anderem Inhalt (der Scrollstand bleibt) */
  async load(): Promise<boolean> {
    const [v, news, extras] = await Promise.all([api.course(this.id).catch(() => null), api.news().catch(() => []), api.courseExtras(this.id).catch(() => null)]);
    if (!v) return false;
    this.fresh = new Set(news.filter((n) => n.course === this.id).map((n) => n.cmid));
    this.extras = extras;
    const sig = JSON.stringify([v, [...this.fresh], extras, this.allNews]);
    if (sig === this.sig) return true;
    const first = !this.view;
    this.sig = sig;
    this.view = v;
    this.el.style.setProperty("--h", String(v.hue));
    this.onView(v);
    this.drawHead(v);
    const top = this.body.scrollTop;
    this.fillBody(v);
    this.drawSide(v);
    this.body.scrollTop = top;
    if (first) requestAnimationFrame(() => lightScroller(this.body, { insetTop: 56, insetBottom: 12, edge: 6 }));
    return true;
  }

  /** Eine Aktivitaet oder einen Abschnitt in die Mitte holen und kurz aufblinken lassen */
  reveal(t: Target) {
    const hit = t.cmid != null
      ? this.body.querySelector<HTMLElement>(`[data-cmid="${t.cmid}"]`)
      : t.section ? [...this.body.querySelectorAll<HTMLElement>(".sec")].find((s) => s.dataset.title === t.section) : null;
    if (!hit) return;
    // nur senkrecht im Seitenkoerper blaettern
    const top = hit.getBoundingClientRect().top - this.body.getBoundingClientRect().top + this.body.scrollTop - (this.body.clientHeight - hit.offsetHeight) / 2;
    this.body.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    hit.classList.remove("flash");
    void hit.offsetWidth;
    hit.classList.add("flash");
  }

  private drawHead(v: CourseView) {
    const ai = iconBtn("spark", "Für KI kopieren", "n-ico sm n-glass n-liquid", () => menu(ai, [
      { icon: "document", label: "Übersicht", hint: "Dateien, Seiten, Anfänge", run: () => void this.copyOutline(false) },
      { icon: "spark", label: "Übersicht + Text", hint: "samt Text aller Dateien", run: () => void this.copyOutline(true) },
    ]));
    const web = iconBtn("external", "LearnWeb", "n-ico sm n-glass n-liquid", () => act(api.openWeb(v.id)));
    web.disabled = !v.web;
    const note = iconBtn("open", v.note ? "Notiz in Obsidian" : "Noch keine Notiz", "n-ico sm n-glass n-liquid", () => act(api.openNote(v.id)));
    note.disabled = !v.note;
    const folder = iconBtn("folder", "Ordner", "n-ico sm n-glass n-liquid", () => act(api.openFolder(v.id)));
    const acts = el("div", "p-acts");
    acts.append(ai, web, note, folder);
    // Titel links (zieht das Fenster), Aktionen rechts; rechts daneben schwebt die Fensterpille
    const drag = (e: HTMLElement) => { e.dataset.tauriDragRegion = ""; return e; };
    const lead = drag(el("div", "cw-lead"));
    const sub = [v.teacher, v.semester].filter(Boolean).join(" · ");
    lead.append(drag(el("i", "cw-dot")), drag(el("h1", "cw-title", v.title)), ...(sub ? [drag(el("span", "cw-sub", sub))] : []));
    this.head.replaceChildren(lead, acts);
  }

  private fillBody(v: CourseView) {
    const ann = this.announcements();
    const secs = v.sections.filter((s) => s.items.length).map((s) => {
      const sec = el("section", "sec");
      sec.dataset.title = s.title;
      sec.append(el("h3", "sec-h", s.title));
      const ul = el("ul", "rows");
      for (const it of s.items) ul.append(this.item(v, it));
      sec.append(ul);
      return sec;
    });
    this.body.replaceChildren(...(ann ? [ann] : []), ...secs);
  }

  /** Ankuendigungen aus den Nachrichtenforen (Text statt Datei); die ersten drei, der Rest auf Wunsch */
  private announcements(): HTMLElement | null {
    const list = this.extras?.news ?? [];
    if (!list.length) return null;
    const sec = el("section", "sec news");
    sec.dataset.title = "Ankündigungen";
    const h = el("h3", "sec-h");
    h.append(ico("forum", 14), " Ankündigungen");
    sec.append(h);
    for (const n of this.allNews ? list : list.slice(0, 3)) sec.append(this.post(n));
    if (list.length > 3) {
      const b = el("button", "nw-all", this.allNews ? "Weniger anzeigen" : `Alle ${list.length} anzeigen`);
      b.addEventListener("click", () => { this.allNews = !this.allNews; this.sig = ""; void this.load(); });
      sec.append(b);
    }
    return sec;
  }

  private post(n: News) {
    const w = el("article", "nw");
    if (n.forum != null) w.dataset.cmid = String(n.forum);
    const when = n.ts ? new Date(n.ts * 1000).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }) : "";
    const h = el("div", "nw-h");
    h.append(el("b", "", n.title || "Ankündigung"), el("small", "", when));
    w.append(h);
    if (n.author) w.append(el("div", "nw-by", n.author));
    if (n.text) {
      const t = el("div", "nw-t", n.text);
      w.append(t);
      if (n.text.length > 260 || n.text.split("\n").length > 5) {
        const more = el("button", "nw-more", "Mehr");
        more.addEventListener("click", () => { const on = w.classList.toggle("open"); more.textContent = on ? "Weniger" : "Mehr"; });
        w.append(more);
      }
    }
    const links = el("div", "nw-l");
    for (const l of n.links.slice(0, 8)) {
      const b = el("button", "", l.text || l.url);
      b.title = l.url;
      b.addEventListener("click", () => act(api.openUrl(l.url)));
      links.append(b);
    }
    for (const f of n.files) {
      const b = el("button", "", f.name || "Datei");
      b.title = f.url;
      b.addEventListener("click", () => act(api.openUrl(f.url)));
      links.append(b);
    }
    if (links.childElementCount) w.append(links);
    return w;
  }

  /** Rechte Spalte: Abgaben dieses Kurses, Dozenten mit Kontakt und Quelle, weitere Kontakte aus Kurstexten */
  private drawSide(v: CourseView) {
    const x = this.extras;
    const panels: HTMLElement[] = [];
    if (x?.assignments.length) {
      const p = el("section");
      const h = el("h3", "ps-h");
      h.append(ico("abgabe"), el("span", "", "Abgaben"), el("small", "", String(x.assignments.length)));
      p.append(h);
      for (const a of x.assignments) {
        const b = el("button", "as");
        b.title = a.intro ? a.intro.slice(0, 400) : a.name;
        const t = el("div", "as-t");
        t.append(el("span", "", a.name));
        if (a.due_ts) t.append(el("span", `chip-l u${urgency(a.due_ts, false)}`, left(a.due_ts, false)));
        b.append(t);
        const status = [a.status, a.due && !a.due_ts ? `fällig ${a.due}` : "", a.remaining].filter(Boolean).join(" · ");
        if (status) b.append(el("div", /abgegeben|eingereicht/i.test(a.status) && !/keine|nicht/i.test(a.status) ? "as-s ok" : "as-s", status));
        b.addEventListener("click", () => { if (v.web) act(api.openWeb(v.id, a.cmid)); });
        p.append(b);
      }
      panels.push(p);
    }
    if (x?.teachers.length || x?.contacts.length) {
      const p = el("section");
      const h = el("h3", "ps-h");
      h.append(ico("user"), el("span", "", "Dozenten und Kontakt"));
      p.append(h);
      for (const t of x?.teachers ?? []) {
        const c = el("div", "tc");
        c.append(el("b", "", t.name), el("small", "", t.role));
        if (t.email) {
          const m = el("button", "tc-m", t.email);
          m.title = "E-Mail schreiben";
          m.addEventListener("click", () => act(api.openUrl(`mailto:${t.email}`)));
          c.append(m);
        }
        for (const [k, val] of Object.entries(t.fields)) { const f = el("div", "tc-f"); f.append(el("span", "", `${k}: `), val); c.append(f); }
        const q = el("div", "tc-q");
        const day = t.checked ? new Date(t.checked * 1000).toLocaleDateString("de-DE") : "";
        q.append(`Quelle: ${t.source}${day ? `, Stand ${day}` : ""}`);
        if (t.profile) {
          const l = el("button", "", " · Profil öffnen");
          l.addEventListener("click", () => act(api.openUrl(t.profile!)));
          q.append(l);
        }
        c.append(q);
        p.append(c);
      }
      if (x?.contacts.length) {
        const c = el("div", "tc");
        c.append(el("small", "", "Weitere Adressen aus dem Kurs"));
        for (const k of x.contacts) {
          const m = el("button", "tc-m", k.email);
          m.title = "E-Mail schreiben";
          m.addEventListener("click", () => act(api.openUrl(`mailto:${k.email}`)));
          c.append(m, el("div", "tc-q", `Quelle: ${k.where}`));
        }
        p.append(c);
      }
      panels.push(p);
    }
    this.side.replaceChildren(...panels);
    this.el.classList.toggle("noside", !panels.length);
  }

  /** Datei -> Folio/Standardprogramm, Ordner -> Dateien darunter, Link -> Browser, Label -> Text */
  private item(v: CourseView, it: ItemView) {
    const li = el("li", "it");
    li.dataset.cmid = String(it.cmid);
    if (it.typ === "label") { li.className = "txt"; li.textContent = it.name; return li; }
    if (this.busy.has(it.cmid)) li.classList.add("busy");
    if (this.fresh.has(it.cmid)) li.classList.add("new");
    /** Zeile; `acts` sind Symbolknoepfe am rechten Rand (beim Zeigen; `show` = immer sichtbar) */
    const row = (name: IconName, label: string, meta: string, run?: () => Promise<unknown>, cls = "", acts: HTMLElement[] = [], show = false) => {
      const w = el("div", "rw");
      const r = el(run ? "button" : "div", `row ${cls}`.trim());
      r.append(ico(name), el("span", "r-name", label), el("span", "r-meta", meta));
      if (run) r.addEventListener("click", () => act(run()));
      w.append(r);
      if (acts.length) {
        const a = el("div", "r-acts");
        a.append(...acts);
        w.append(a);
        w.classList.add("has-acts");
        w.classList.toggle("show", show);
      }
      return w;
    };
    const copy = (idx: number) => iconBtn("copy", "Datei kopieren", "n-ico sm", () => act(api.copyFile(v.id, it.cmid, idx).then(() => toast("Kopiert"))));
    const load = (all: boolean) => iconBtn("download", all ? "Laden (auch große Dateien)" : "Laden", "n-ico sm", () => void this.download(it, all));
    const external = () => iconBtn("external", "LearnWeb", "n-ico sm", () => act(api.openWeb(v.id, it.cmid)));
    const fetchable = it.typ === "resource" || it.typ === "folder";
    const single = it.files.length === 1 && it.typ !== "folder";
    if (single) li.append(row(typeIcon(it.typ), it.name, it.files[0].ext.toUpperCase(), () => api.openFile(v.id, it.cmid, it.files[0].idx), "", [copy(it.files[0].idx)]));
    else if (it.files.length) {
      li.append(row(typeIcon(it.typ), it.name, String(it.files.length), undefined, "head"));
      for (const f of it.files) li.append(row("document", f.name, f.ext.toUpperCase(), () => api.openFile(v.id, it.cmid, f.idx), "sub", [copy(f.idx)]));
    } else {
      // keine Datei auf der Platte: laden (wenn es eine Datei oder ein Ordner ist und nichts als zu gross vermerkt ist)
      const get = fetchable && !it.skipped_mb.length ? [load(false)] : [];
      if (it.web) {
        const w = row(typeIcon(it.typ), it.name, "", () => api.openWeb(v.id, it.cmid), "web", get, true);
        w.querySelector(".r-meta")!.append(ico("external", 13));
        li.append(w);
      } else li.append(row(typeIcon(it.typ), it.name, "", undefined, "plain", get, true));
    }
    // zu gross: ein Klick laedt es ausdruecklich trotzdem
    for (const mb of it.skipped_mb) li.append(row("download", `${num(mb)} MB`, "", () => this.download(it, true), "note", it.web ? [external()] : []));
    if (it.error) {
      const w = row("refresh", "", "", () => this.download(it, false), "note");
      w.title = "Erneut laden";
      li.append(w);
    }
    return li;
  }

  /** Sofort laden (ueber die Python-Seite); `all` = auch Dateien, die beim Sync als zu gross uebersprungen wurden */
  private async download(it: ItemView, all: boolean) {
    if (this.busy.has(it.cmid)) return;
    this.busy.add(it.cmid);
    const mark = (on: boolean) => this.body.querySelectorAll<HTMLElement>(`[data-cmid="${it.cmid}"]`).forEach((n) => n.classList.toggle("busy", on));
    mark(true);
    try {
      const r = await api.fetch(this.id, it.cmid, all);
      toast(`${r.files} ${r.files === 1 ? "Datei" : "Dateien"} geladen${r.skipped ? ` · ${r.skipped} zu groß` : ""}`);
      await this.load();
    } catch (e) {
      if ((e as Partial<FetchError> | null)?.code === "too_large") toast(message(e), { label: "Trotzdem laden", run: () => void this.download(it, true) });
      else toast(message(e));
    } finally {
      this.busy.delete(it.cmid);
      mark(false);
    }
  }

  /** Uebersicht (mit Text) des Kurses als Markdown in die Zwischenablage, fuer Claude/ChatGPT */
  private async copyOutline(withText: boolean) {
    try {
      const o = await api.forAi(this.id, withText);
      await copyText(o.text);
      toast(`Kopiert · ${num(o.chars)} Zeichen${o.truncated ? " (gekürzt)" : ""}`);
    } catch (e) {
      toast(message(e));
    }
  }
}
