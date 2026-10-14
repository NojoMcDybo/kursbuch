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
export type Link = { view: "heute" } | { view: "fokus" } | { view: "kurs"; arg: number } | { view: "suche"; arg: string };

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

/** Eintrag im Stundenplan: woechentlicher Termin; day Montag = 0, start/end in Minuten seit Mitternacht */
export type Entry = { id: string; title: string; day: number; start: number; end: number; room: string; course: number | null };
export type Plans = Record<string, Entry[]>;
export type Imported = { entries: Entry[]; skipped: number };
/** LearnWeb-Anmeldung: gespeichert (Kennung) und ob gerade ein Sync laeuft */
export type Account = { saved: boolean; user: string | null; running: boolean };

/** Fokus: To-do-Listen, Pomodoro-Einstellungen (Minuten) und Lernstreaks (Rust: focus.rs) */
export type Todo = { id: string; text: string; done: boolean };
export type TodoList = { id: string; name: string; items: Todo[] };
export type FocusSettings = { focus: number; pause: number };
/** days: (Tag seit 1970 im lokalen Kalender, Sitzungen) der letzten 12 Wochen; today_day = heute im selben Mass */
export type FocusStats = { current: number; best: number; today: number; today_minutes: number; total: number; days: [number, number][]; today_day: number };
export type Focus = { lists: TodoList[]; settings: FocusSettings; stats: FocusStats };
/** Stand des Pomodoro fuer die Karte in der Notch (Rust: pomodoro.rs) */
export type PomoNotch = { phase: "focus" | "short" | "long"; status: "running" | "paused" | "ready"; ends_at: number; left: number; total: number; task: string; round: number; rounds: number };

/** Inhalte ohne Datei (Python: content.py, Rust: content.rs) */
export type WebLink = { text: string; url: string };
export type News = { id: number | null; forum: number | null; forum_name: string; title: string; author: string; ts: number | null; text: string; links: WebLink[]; files: { name: string; url: string }[]; url: string | null };
export type Assignment = { cmid: number; name: string; url: string | null; intro: string; links: WebLink[]; due: string | null; status: string; grading: string; remaining: string; due_ts: number | null };
export type Teacher = { id: number; name: string; role: string; email: string | null; profile: string | null; fields: Record<string, string>; source: string; checked: number | null };
export type Extras = { news: News[]; assignments: Assignment[]; teachers: Teacher[]; contacts: { email: string; where: string }[] };
/** Selbst-Update (Rust: update.rs) */
export type Upd = { status: "idle" | "checking" | "current" | "available" | "downloading" | "error"; version?: string; current: string; message?: string };

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
  /** Kurs in eigenem Fenster oeffnen; optional eine Aktivitaet oder einen Abschnitt zeigen */
  openCourse: (course: number, cmid?: number, section?: string) => invoke<void>("open_course", { course, cmid: cmid ?? null, section: section ?? null }),
  timetableGet: () => invoke<Plans>("timetable_get"),
  timetableSave: (semester: string, entries: Entry[]) => invoke<void>("timetable_save", { semester, entries }),
  timetableImport: (text: string) => invoke<Imported>("timetable_import", { text }),
  /** schreibt .ics in „Downloads“ und zeigt sie im Explorer; Rueckgabe: Pfad. from/to als JJJJ-MM-TT */
  timetableExport: (semester: string, from: string, to: string) => invoke<string>("timetable_export", { semester, from, to }),
  accountStatus: () => invoke<Account>("account_status"),
  accountLogin: (user: string, password: string) => invoke<void>("account_login", { user, password }),
  accountLogout: () => invoke<void>("account_logout"),
  focusGet: () => invoke<Focus>("focus_get"),
  focusSave: (lists: TodoList[], settings: FocusSettings) => invoke<void>("focus_save", { lists, settings }),
  /** eine abgeschlossene Fokusphase festhalten; Rueckgabe: neue Zahlen */
  focusLog: (minutes: number, task: string) => invoke<FocusStats>("focus_log", { minutes, task }),
  /** Timer fuer die Notch; null = beendet */
  pomodoroNotch: (state: PomoNotch | null) => invoke<void>("pomodoro_notch", { state }),
  courseExtras: (course: number) => invoke<Extras>("course_extras", { course }),
  /** http(s) und mailto; Rust prueft noch einmal */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  /** Pomodoro-Widget (eigenes Fenster) zeigen oder schliessen; x/y = gemerkte Lage */
  pomodoroWidget: (show: boolean, x?: number, y?: number) => invoke<void>("pomodoro_widget", { show, x: x ?? null, y: y ?? null }),
  updateState: () => invoke<Upd>("update_state"),
  updateCheck: () => invoke<Upd>("update_check"),
  updateInstall: () => invoke<void>("update_install"),
  takePending: () => invoke<Link | null>("take_pending"),
};
