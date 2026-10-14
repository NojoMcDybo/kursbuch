/**
 * Kursseite im eigenen Fenster: Kopf mit Aktionen (Fuer KI kopieren, LearnWeb, Notiz, Ordner), darunter die Abschnitte als
 * fortlaufende Seite ohne Karten. Zeilen: Datei oeffnen, kopieren, laden; „zu gross“ laedt ein Klick trotzdem. Aktivitaeten, die
 * seit dem letzten Oeffnen neu oder aktualisiert sind, tragen einen Punkt.
 */

import { api, type CourseView, type FetchError, type ItemView } from "./api";
import { lightScroller, type IconName } from "./nojo/nojo-ui";
import { act, copyText, el, ico, iconBtn, menu, message, num, toast, typeIcon } from "./ui";

/** Stelle, die die Seite zeigen soll: eine Aktivitaet oder ein Abschnitt (nach Titel) */
export type Target = { cmid?: number | null; section?: string | null };

export class CoursePage {
  readonly el = el("article", "cp");
  private head = el("header", "p-head");
  private body = el("div", "p-body");
  private view: CourseView | null = null;
  private sig = "";
  private fresh = new Set<number>();
  /** laufende Sofort-Downloads (cmid) */
  private busy = new Set<number>();

  constructor(readonly id: number, private onView: (v: CourseView) => void) {
    this.el.append(this.head, this.body);
    this.el.style.setProperty("--h", "215");
  }

  /** Stand holen; neu gezeichnet wird nur bei anderem Inhalt (der Scrollstand bleibt) */
  async load(): Promise<boolean> {
    const [v, news] = await Promise.all([api.course(this.id).catch(() => null), api.news().catch(() => [])]);
    if (!v) return false;
    this.fresh = new Set(news.filter((n) => n.course === this.id).map((n) => n.cmid));
    const sig = JSON.stringify([v, [...this.fresh]]);
    if (sig === this.sig) return true;
    const first = !this.view;
    this.sig = sig;
    this.view = v;
    this.el.style.setProperty("--h", String(v.hue));
    this.onView(v);
    this.drawHead(v);
    const top = this.body.scrollTop;
    this.fillBody(v);
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
    this.head.replaceChildren(acts);
  }

  private fillBody(v: CourseView) {
    const secs = v.sections.filter((s) => s.items.length).map((s) => {
      const sec = el("section", "sec");
      sec.dataset.title = s.title;
      sec.append(el("h3", "sec-h", s.title));
      const ul = el("ul", "rows");
      for (const it of s.items) ul.append(this.item(v, it));
      sec.append(ul);
      return sec;
    });
    this.body.replaceChildren(...secs);
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
