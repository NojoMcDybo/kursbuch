/**
 * Konto (oben links): Kreis mit Statuspunkt (gruen = Sync aktuell, gelb = lange her, grau = nicht angemeldet). Ein Klick oeffnet
 * die LearnWeb-Anmeldung bzw. zeigt, wer angemeldet ist. Das Passwort geht nur einmal an die Python-Seite, die es bei LearnWeb
 * prueft und im Windows-Tresor ablegt; die App behaelt nichts davon (das Feld wird nach jedem Versuch geleert).
 */

import { listen } from "@tauri-apps/api/event";
import { api, type Account as Status, type Upd } from "./api";
import { ago } from "./dates";
import { el, ico, iconBtn, message, toast } from "./ui";

/** Anmeldeformular (Kennung, Passwort): im Konto-Menue und auf dem Anmeldebild. `onDone` nach geglueckter Anmeldung. */
export function loginForm(onDone: () => void): HTMLFormElement {
  const form = el("form", "ap-f");
  form.autocomplete = "off";
  form.noValidate = true;
  const user = el("input", "n-input");
  user.placeholder = "Uni-Kennung";
  user.autocomplete = "username";
  user.setAttribute("aria-label", "Uni-Kennung");
  user.maxLength = 64;
  const pw = el("input", "n-input");
  pw.type = "password";
  pw.placeholder = "Passwort";
  pw.autocomplete = "off";
  pw.setAttribute("aria-label", "Passwort");
  const err = el("p", "ap-err");
  const go = el("button", "n-btn primary", "Anmelden");
  go.type = "submit";
  form.append(user, pw, err, go);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!user.value.trim() || !pw.value) { err.textContent = "Kennung und Passwort eintragen."; return; }
    const password = pw.value;
    pw.value = ""; // das Passwort verlaesst die Oberflaeche sofort
    err.textContent = "";
    go.disabled = user.disabled = pw.disabled = true;
    go.textContent = "Prüfe …";
    api.accountLogin(user.value.trim(), password)
      .then(() => { toast("Angemeldet"); onDone(); })
      .catch((e) => { err.textContent = message(e); go.disabled = user.disabled = pw.disabled = false; go.textContent = "Anmelden"; pw.focus(); });
  });
  return form;
}

export type AccountOpts = {
  /** Anmeldung oder Abmeldung ist geschehen: Daten neu holen */
  onChange: () => void;
  /** Stand der gespeicherten Zugangsdaten (nach jeder Abfrage) */
  onStatus: (saved: boolean) => void;
};

export class Account {
  readonly el = iconBtn("user", "LearnWeb-Konto", "n-ico sm n-glass n-liquid acct", () => this.toggle());
  private dot = el("i", "acct-dot off");
  private pop: HTMLElement | null = null;
  private status: Status | null = null;
  private lastRun: number | null = null;
  private upd: Upd | null = null;

  constructor(private o: AccountOpts) {
    void api.updateState().then((u) => { this.upd = u; this.paintDot(); }).catch(() => {});
    void listen<Upd>("update", (e) => { this.upd = e.payload; this.paintDot(); if (this.pop) this.draw(); });
    this.el.append(this.dot);
    this.el.setAttribute("aria-haspopup", "dialog");
  }

  /** Zeitpunkt des letzten Syncs (aus der Uebersicht) */
  setSync(lastRun: number | null) {
    this.lastRun = lastRun;
    this.paintDot();
    if (this.pop) this.draw();
  }

  async refresh() {
    this.status = await api.accountStatus().catch(() => null);
    if (this.status) this.o.onStatus(this.status.saved);
    this.paintDot();
    if (this.pop) this.draw();
  }

  private paintDot() {
    const age = this.lastRun ? Date.now() / 1000 - this.lastRun : Infinity;
    const cls = !this.status?.saved ? "off" : age < 36 * 3600 ? "ok" : "wait";
    this.dot.className = `acct-dot ${cls}`;
    this.el.querySelector(".n-dot")?.remove();
    if (this.upd?.status === "available") this.el.append(el("i", "n-dot")); // es gibt eine neue Version
    this.el.title = this.status?.saved ? `LearnWeb: ${this.status.user ?? ""}${this.lastRun ? ` · Sync ${ago(this.lastRun)}` : ""}` : "Bei LearnWeb anmelden";
  }

  private toggle() {
    if (this.pop) this.close(); else this.openPop();
  }

  private close() {
    this.pop?.remove();
    this.pop = null;
    document.removeEventListener("pointerdown", this.away, true);
    document.removeEventListener("keydown", this.key, true);
  }

  private away = (e: Event) => { if (this.pop && !this.pop.contains(e.target as Node) && !this.el.contains(e.target as Node)) this.close(); };
  private key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); this.close(); this.el.focus(); } };

  private openPop() {
    this.pop = el("div", "ap");
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-label", "LearnWeb-Konto");
    document.body.append(this.pop);
    const r = this.el.getBoundingClientRect();
    this.pop.style.top = `${r.bottom + 8}px`;
    this.pop.style.left = `${Math.max(8, r.left)}px`;
    document.addEventListener("pointerdown", this.away, true);
    document.addEventListener("keydown", this.key, true);
    this.draw();
    void this.refresh();
  }

  /** Version und Selbst-Update (Rust: update.rs): sucht beim Start und alle 6 Stunden; hier auch auf Wunsch */
  private updateRow() {
    const u = this.upd ?? { status: "idle", current: "" } as Upd;
    const row = el("div", "ap-up");
    const text = { idle: "Sucht beim Start nach Updates", checking: "Sucht …", current: "Aktuell", available: `Version ${u.version} ist da`, downloading: "Lädt – Kursbuch startet gleich neu …", error: u.message ?? "Prüfung fehlgeschlagen" }[u.status];
    row.append(el("span", "", `${u.current ? `Kursbuch ${u.current} · ` : ""}${text}`));
    const b = el("button", `n-btn${u.status === "available" ? " primary" : ""}`, u.status === "available" ? "Installieren" : "Suchen");
    b.disabled = u.status === "checking" || u.status === "downloading";
    b.addEventListener("click", () => {
      if (u.status === "available") void api.updateInstall().catch((e) => toast(message(e)));
      else void api.updateCheck().then((n) => { this.upd = n; this.paintDot(); this.draw(); }).catch((e) => toast(message(e)));
    });
    row.append(b);
    return row;
  }

  private draw() {
    const pop = this.pop;
    if (!pop) return;
    const s = this.status;
    if (s?.saved) {
      const head = el("div", "ap-h");
      head.append(el("span", "ap-av", (s.user ?? "?").slice(0, 1).toUpperCase()), el("div", "ap-id"));
      const id = head.querySelector(".ap-id")!;
      id.append(el("b", "", s.user ?? ""), el("small", "", this.lastRun ? `Sync ${ago(this.lastRun)}` : "Noch kein Sync"));
      const out = el("button", "n-btn", "Abmelden");
      out.addEventListener("click", () => {
        out.disabled = true;
        api.accountLogout().then(() => { toast("Abgemeldet"); return this.refresh(); }).then(() => this.o.onChange()).catch((e) => toast(message(e))).finally(() => { out.disabled = false; });
      });
      pop.replaceChildren(head, out, this.updateRow());
      return;
    }
    const form = loginForm(() => { void this.refresh().then(() => this.o.onChange()); });
    const head = el("div", "ap-t");
    head.append(ico("lock"), el("span", "", "LearnWeb"));
    form.prepend(head);
    pop.replaceChildren(form, this.updateRow());
    form.querySelector<HTMLInputElement>("input")?.focus();
  }
}
