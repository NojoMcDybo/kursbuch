/** Kurse: Raster aller Kurse (nach Semester) und die Kursansicht (Abschnitte wie in LearnWeb, Dateien, Links). */

import { api, type CourseCard, type CourseView, type ItemView, type Overview } from "./api";
import type { IconName } from "./nojo/nojo-ui";
import { act, announce, el, ico, plural } from "./ui";

/** Symbol je Aktivitaetstyp; Unbekanntes bekommt „Öffnen“ */
const TYPE_ICON: Record<string, IconName> = {
  resource: "document", folder: "folder", url: "link", forum: "forum", assign: "abgabe", opencast: "video", zoom: "video",
  scheduler: "kalender", h5pactivity: "pointer", data: "layout", ratingallocate: "check", feedback: "check",
};
const typeIcon = (t: string): IconName => TYPE_ICON[t] ?? "open";

let host: HTMLElement;
let last: Overview | null = null;
/** geoeffneter Kurs (null = Raster) */
let current: number | null = null;

export function initCourses(root: HTMLElement) {
  host = root;
  document.addEventListener("keydown", (e) => {
    const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select");
    if (current != null && !typing && !host.hidden && (e.key === "Escape" || e.key === "Backspace")) { e.preventDefault(); showGrid(); }
  });
}

/** Neuer Stand von Rust: Raster neu zeichnen, die offene Kursansicht frisch laden */
export function renderCourses(o: Overview) {
  last = o;
  if (current != null) void openCourse(current, true);
  else drawGrid();
}

export function showGrid() {
  current = null;
  drawGrid();
}

export async function openCourse(id: number, quiet = false) {
  let c: CourseView;
  try {
    c = await api.course(id);
  } catch (e) {
    current = null;
    if (!quiet) drawGrid();
    host.prepend(notice(typeof e === "string" ? e : "Der Kurs lässt sich nicht öffnen."));
    return;
  }
  current = id;
  drawCourse(c);
  announce(c.title);
}

// --------------------------------------------------------------------------- Raster

function notice(text: string, sub = "", icon: IconName = "kursbuch") {
  const d = el("div", "empty n-card");
  d.append(ico(icon, 34), el("p", "", text));
  if (sub) d.append(el("p", "faint", sub));
  d.firstElementChild!.classList.add("empty-ico");
  return d;
}

function drawGrid() {
  host.replaceChildren();
  const o = last;
  if (!o) return;
  if (o.status === "no_state") {
    host.append(notice("Noch kein Sync gelaufen.", "Sobald der erste Sync durch ist, erscheinen hier deine Kurse."));
    return;
  }
  if (o.status === "error") {
    host.append(notice(o.error ?? "Der Stand von LearnWeb lässt sich nicht lesen.", "", "refresh"));
    return;
  }
  if (!o.courses.length) {
    host.append(notice("Keine Kurse im Sync."));
    return;
  }
  let group = "";
  let grid: HTMLElement | null = null;
  for (const c of o.courses) {
    const g = c.semester ?? "Weitere";
    if (g !== group || !grid) {
      group = g;
      host.append(el("h2", "n-eyebrow grp", g));
      grid = el("div", "grid");
      host.append(grid);
    }
    grid.append(tile(c));
  }
}

function tile(c: CourseCard) {
  const b = el("button", "tile n-card lift");
  b.append(el("h3", "t-title", c.title));
  if (c.teacher) b.append(el("p", "t-teacher", c.teacher));
  const foot = el("div", "t-foot");
  const stat = (name: IconName, n: number, title: string, cls = "") => {
    const s = el("span", `t-stat ${cls}`.trim());
    s.title = title;
    s.append(ico(name), String(n));
    foot.append(s);
  };
  stat("document", c.files, plural(c.files, "Datei", "Dateien"));
  if (c.skipped) stat("download", c.skipped, `${plural(c.skipped, "Datei", "Dateien")} zu groß zum Spiegeln`, "warn");
  if (c.errors) stat("refresh", c.errors, `${plural(c.errors, "Download", "Downloads")} fehlgeschlagen, der nächste Sync versucht es erneut`, "warn");
  b.append(foot);
  b.addEventListener("click", () => void openCourse(c.id));
  return b;
}

// --------------------------------------------------------------------------- Kursansicht

function drawCourse(c: CourseView) {
  host.replaceChildren();

  const top = el("div", "c-top");
  const back = el("button", "n-ico back");
  back.title = "Zurück (Esc)";
  back.setAttribute("aria-label", "Zurück zu allen Kursen");
  back.append(ico("back"));
  back.addEventListener("click", showGrid);
  const titles = el("div", "c-titles");
  titles.append(el("h1", "c-title", c.title));
  const sub = [c.semester, c.teacher].filter(Boolean).join(" · ");
  if (sub) titles.append(el("p", "c-sub", sub));
  const acts = el("div", "c-acts");
  const action = (name: IconName, label: string, title: string, run: () => Promise<void>, off = false) => {
    const b = el("button", "n-btn");
    b.append(ico(name), label);
    b.title = title;
    b.disabled = off;
    b.addEventListener("click", () => act(run()));
    acts.append(b);
  };
  action("external", "LearnWeb", "Kurs in LearnWeb öffnen (Browser)", () => api.openWeb(c.id), !c.web);
  action("open", "Obsidian", c.note ? "Kursnotiz in Obsidian öffnen" : "Die Kursnotiz gibt es noch nicht", () => api.openNote(c.id), !c.note);
  action("folder", "Ordner", "Kursordner im Explorer zeigen", () => api.openFolder(c.id));
  top.append(back, titles, acts);

  const secs = el("div", "secs");
  for (const s of c.sections) {
    const d = el("details", "sec n-card");
    d.open = true;
    const sum = el("summary");
    sum.append(el("span", "s-title", s.title), el("span", "s-count", s.items.length ? String(s.items.length) : ""), ico("down"));
    d.append(sum);
    if (!s.items.length) d.append(el("p", "s-empty", "Nur Beschreibungstext, siehe LearnWeb"));
    else {
      const ul = el("ul", "items");
      for (const it of s.items) ul.append(item(c, it));
      d.append(ul);
    }
    secs.append(d);
  }
  host.append(top, secs);
}

/** Eine Aktivitaet: Datei -> in Folio/Standardprogramm, Ordner -> Dateien darunter, sonst -> Browser */
function item(c: CourseView, it: ItemView) {
  const li = el("li", "it");
  const single = it.files.length === 1 && it.typ !== "folder";
  const row = (name: IconName, label: string, meta: string, run?: () => Promise<void>, cls = "") => {
    const r = el(run ? "button" : "div", `row ${cls}`.trim());
    r.append(ico(name), el("span", "r-name", label), el("span", "r-meta", meta));
    if (run) r.addEventListener("click", () => act(run()));
    return r;
  };

  if (single) {
    li.append(row(typeIcon(it.typ), it.name, it.files[0].ext.toUpperCase(), () => api.openFile(c.id, it.cmid, it.files[0].idx)));
  } else if (it.files.length) {
    li.append(row(typeIcon(it.typ), it.name, plural(it.files.length, "Datei", "Dateien"), undefined, "head"));
    for (const f of it.files) li.append(row("document", f.name, f.ext.toUpperCase(), () => api.openFile(c.id, it.cmid, f.idx), "sub"));
  } else if (it.web) {
    li.append(row(typeIcon(it.typ), it.name, "", () => api.openWeb(c.id, it.cmid), "web"));
    li.lastElementChild!.querySelector(".r-meta")!.append(ico("external", 14));
  } else {
    li.append(row(typeIcon(it.typ), it.name, "", undefined, "plain"));
  }
  for (const mb of it.skipped_mb) {
    const r = row("download", `Datei zu groß (${mb.toLocaleString("de-DE")} MB), nicht gespiegelt`, "", it.web ? () => api.openWeb(c.id, it.cmid) : undefined, "note");
    li.append(r);
  }
  if (it.error) li.append(row("refresh", "Download fehlgeschlagen, der nächste Sync versucht es erneut", "", undefined, "note"));
  return li;
}
