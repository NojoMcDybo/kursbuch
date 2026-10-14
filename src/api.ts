/** Schnittstelle zu Rust (src-tauri/src/data.rs, open.rs, links.rs): typisiert, die Oberflaeche nennt nur IDs. */

import { invoke } from "@tauri-apps/api/core";

export type CourseCard = {
  id: number;
  title: string;
  semester: string | null;
  teacher: string | null;
  activities: number;
  files: number;
  /** zu gross zum Spiegeln */
  skipped: number;
  errors: number;
};

/** no_state = noch kein Sync gelaufen */
export type Overview = { status: "ok" | "no_state" | "error"; error: string | null; last_run: number | null; courses: CourseCard[] };

export type FileView = { idx: number; name: string; ext: string };
export type ItemView = { cmid: number; name: string; typ: string; files: FileView[]; skipped_mb: number[]; error: boolean; web: boolean };
export type SectionView = { title: string; items: ItemView[] };
export type CourseView = {
  id: number;
  title: string;
  semester: string | null;
  teacher: string | null;
  web: boolean;
  note: boolean;
  sections: SectionView[];
};

/** Deep Link kursbuch://… */
export type Link = { view: "heute" } | { view: "kurs"; arg: number } | { view: "suche"; arg: string };

export const api = {
  overview: () => invoke<Overview>("overview"),
  course: (id: number) => invoke<CourseView>("course", { id }),
  openFile: (course: number, cmid: number, idx: number) => invoke<void>("open_file", { course, cmid, idx }),
  /** ohne cmid: die Seite des Kurses */
  openWeb: (course: number, cmid?: number) => invoke<void>("open_web", { course, cmid: cmid ?? null }),
  openNote: (course: number) => invoke<void>("open_note", { course }),
  openFolder: (course: number) => invoke<void>("open_folder", { course }),
  takePending: () => invoke<Link | null>("take_pending"),
};
