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
  takePending: () => invoke<Link | null>("take_pending"),
};
