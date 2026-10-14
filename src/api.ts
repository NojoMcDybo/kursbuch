/** Schnittstelle zu Rust (src-tauri/src/*.rs): typisiert, die Oberflaeche nennt nur IDs. */

import { invoke } from "@tauri-apps/api/core";

export type CourseCard = {
  id: number;
  title: string;
  semester: string | null;
  teacher: string | null;
  /** Farbton des Kurses (0-359), bleibt gleich */
  hue: number;
  activities: number;
  files: number;
  /** zu gross zum Spiegeln */
  skipped: number;
  errors: number;
};

/** no_state = noch kein Sync gelaufen */
export type Overview = { status: "ok" | "no_state" | "error"; error: string | null; last_run: number | null; courses: CourseCard[] };

export type FileView = { idx: number; name: string; ext: string };
/** typ "label" = reiner Text im Kurs (name ist der Text) */
export type ItemView = { cmid: number; name: string; typ: string; files: FileView[]; skipped_mb: number[]; error: boolean; web: boolean };
export type SectionView = { title: string; items: ItemView[] };
export type CourseView = {
  id: number;
  title: string;
  semester: string | null;
  teacher: string | null;
  hue: number;
  web: boolean;
  note: boolean;
  sections: SectionView[];
};

export type EvKind = "sitzung" | "frist" | "pruefung" | "termin";
/** Termin; ts = Unix-Sekunden, allDay = ohne Uhrzeit, source = lernweb | abschnitt | label */
export type Ev = { id: string; ts: number; allDay: boolean; kind: EvKind; title: string; short: string; course: number | null; source: string; overdue: boolean };

/** Neu oder aktualisiert seit dem letzten Oeffnen; file = Nummer der einzigen Datei (Klick oeffnet sie) */
export type NewItem = { course: number; cmid: number; name: string; typ: string; file: number | null; ts: number; updated: boolean };

/** Deep Link kursbuch://… */
export type Link = { view: "heute" } | { view: "kurs"; arg: number } | { view: "suche"; arg: string };

/** Lage der Notch in Fensterkoordinaten (nur wenn sie laeuft) */
export type NotchRect = { dock: "top" | "left" | "right"; x: number; y: number; w: number; h: number };

/** Treffer der Suche: eine Datei (mit den besten Seiten) oder ein Name aus LearnWeb; Ausschnitt mit \u0001 … \u0002 um die Treffer, kein HTML */
export type HitKind = "course" | "section" | "activity" | "pdf" | "docx" | "pptx";
export type Hit = { kind: HitKind; course: number; cmid: number | null; path: string; title: string; pages: number[]; snippet: string; file: number | null; count: number };
export type Found = { hits: Hit[]; ms: number; indexed: boolean; words: string[] };
export type Outline = { text: string; chars: number; truncated: boolean };
export type Fetched = { files: number; skipped: number };
/** code: too_large | locked | login | learnweb | network | credentials | start */
export type FetchError = { code: string; message: string };

export const api = {
  overview: () => invoke<Overview>("overview"),
  course: (id: number) => invoke<CourseView>("course", { id }),
  events: () => invoke<Ev[]>("events"),
  news: () => invoke<NewItem[]>("news"),
  markRead: () => invoke<void>("mark_read"),
  notchRect: () => invoke<NotchRect | null>("notch_rect"),
  openFile: (course: number, cmid: number, idx: number) => invoke<void>("open_file", { course, cmid, idx }),
  /** ohne cmid: die Seite des Kurses */
  openWeb: (course: number, cmid?: number) => invoke<void>("open_web", { course, cmid: cmid ?? null }),
  openNote: (course: number) => invoke<void>("open_note", { course }),
  openFolder: (course: number) => invoke<void>("open_folder", { course }),
  /** _Verzeichnis.md in Obsidian */
  openDirectory: () => invoke<void>("open_directory"),
  /** courses leer = alle Kurse; deep = tiefe Suche (Wortstaemme, ODER, nach Dichte) */
  search: (q: string, deep: boolean, courses: number[]) => invoke<Found>("search", { q, deep, courses }),
  /** Markdown fuer Claude/ChatGPT: ohne Kurs das ganze Verzeichnis, sonst ein Kurs (mit withText samt Text der Dateien) */
  forAi: (course: number | null, withText: boolean) => invoke<Outline>("for_ai", { course, withText }),
  /** Datei als Datei in die Zwischenablage */
  copyFile: (course: number, cmid: number, idx: number) => invoke<void>("copy_file", { course, cmid, idx }),
  /** Sofort laden; allSizes = auch Dateien, die zu gross zum Spiegeln waren. Fehler: FetchError */
  fetch: (course: number, cmid: number, allSizes: boolean) => invoke<Fetched>("fetch", { course, cmid, allSizes }),
  takePending: () => invoke<Link | null>("take_pending"),
};
