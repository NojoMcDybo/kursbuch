/** Datumshilfen in Ortszeit. Ein „Tag“ ist eine ganze Zahl (Tage seit 1970 im lokalen Kalender), damit Sommerzeit nichts verschiebt. */

export const dayOf = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
export const dayOfTs = (ts: number) => dayOf(new Date(ts * 1000));
export const todayDay = () => dayOf(new Date());
/** Datum (lokale Mitternacht) zu einer Tageszahl */
export const dateOf = (day: number) => { const u = new Date(day * 86_400_000); return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()); };

const pad = (n: number) => String(n).padStart(2, "0");
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
export const weekday = (d: Date) => WD[d.getDay()];
/** Montag = 0 … Sonntag = 6 */
export const weekdayIndex = (d: Date) => (d.getDay() + 6) % 7;
export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** „Mo 14.10.“ bzw. „Mo 14.10. 12:00“ */
export function when(ts: number, allDay: boolean) {
  const d = new Date(ts * 1000);
  return `${weekday(d)} ${d.getDate()}.${d.getMonth() + 1}.${allDay ? "" : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`}`;
}

/** Restzeit kurz: „überfällig“, „12 Min“, „5 Std“, „heute“, „3 T“ (volle Kalendertage, nicht 24-Stunden-Blöcke) */
export function left(ts: number, allDay: boolean, now = Date.now() / 1000) {
  if (!allDay && ts < now) return "überfällig";
  const days = dayOfTs(ts) - todayDay();
  if (days < 0) return "vorbei";
  if (days === 0) {
    if (allDay) return "heute";
    const m = Math.ceil((ts - now) / 60);
    return m < 60 ? `${m} Min` : `${Math.ceil(m / 60)} Std`;
  }
  return `${days} T`;
}

/** Stufe fuer die Farbe der Restzeit: 0 = weit, 1 = unter 48 Stunden, 2 = ueberfaellig */
export function urgency(ts: number, allDay: boolean, now = Date.now() / 1000) {
  if (!allDay && ts < now) return 2;
  return dayOfTs(ts) - todayDay() <= 1 ? 1 : 0;
}

/** „heute 13:40“, „gestern 07:15“, „12.10. 07:15“ (Unix-Sekunden) */
export function ago(unix: number) {
  const d = new Date(unix * 1000);
  const days = todayDay() - dayOfTs(unix);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return days === 0 ? `heute ${t}` : days === 1 ? `gestern ${t}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${t}`;
}
