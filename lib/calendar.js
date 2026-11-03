// Calendar files (.ics / .ical, RFC 5545) to Markdown: one section per
// event / task / journal entry with the fields people actually read (time,
// place, organizer, attendees, recurrence, meeting link) and the
// description as body. Invitations from Outlook, Google and Apple differ
// mostly in how they write time zones; see resolveZone().
import { parseVFormat, findComponents, getProp, getProps, param } from './vformat.js';
import { filenameStem, removeElements, trimEndChars, trimLineEnds } from './text-decode.js';
import { formatMailDate, unprocessable } from './mail-render.js';

const LABELS = {
  de: {
    start: 'Beginn', end: 'Ende', date: 'Datum', allDay: 'ganztägig', duration: 'Dauer', due: 'Fällig',
    location: 'Ort', organizer: 'Organisator', attendees: 'Teilnehmer', repeats: 'Wiederholung',
    status: 'Status', url: 'URL', online: 'Online-Meeting', type: 'Art',
    untitled: '(ohne Titel)', calendar: 'Kalender',
    method: { REQUEST: 'Einladung', CANCEL: 'Absage', REPLY: 'Antwort', COUNTER: 'Gegenvorschlag' },
    kind: { VTODO: 'Aufgabe', VJOURNAL: 'Notiz' },
    eventStatus: { CANCELLED: 'Abgesagt', TENTATIVE: 'Vorläufig' },
    todoStatus: { 'NEEDS-ACTION': 'Offen', 'IN-PROCESS': 'In Bearbeitung', COMPLETED: 'Erledigt', CANCELLED: 'Abgebrochen' },
    partstat: { ACCEPTED: 'zugesagt', DECLINED: 'abgesagt', TENTATIVE: 'vorläufig', DELEGATED: 'delegiert' },
    role: { 'OPT-PARTICIPANT': 'optional', 'NON-PARTICIPANT': 'zur Information', CHAIR: 'Leitung' },
    cutype: { ROOM: 'Raum', RESOURCE: 'Ressource' },
    units: [['Woche', 'Wochen'], ['Tag', 'Tage'], ['Stunde', 'Stunden'], ['Minute', 'Minuten'], ['Sekunde', 'Sekunden']],
    weekdays: { MO: 'Montag', TU: 'Dienstag', WE: 'Mittwoch', TH: 'Donnerstag', FR: 'Freitag', SA: 'Samstag', SU: 'Sonntag' },
  },
  en: {
    start: 'Start', end: 'End', date: 'Date', allDay: 'all day', duration: 'Duration', due: 'Due',
    location: 'Location', organizer: 'Organizer', attendees: 'Attendees', repeats: 'Repeats',
    status: 'Status', url: 'URL', online: 'Online meeting', type: 'Type',
    untitled: '(untitled)', calendar: 'Calendar',
    method: { REQUEST: 'Invitation', CANCEL: 'Cancellation', REPLY: 'Reply', COUNTER: 'Counter-proposal' },
    kind: { VTODO: 'Task', VJOURNAL: 'Journal entry' },
    eventStatus: { CANCELLED: 'Cancelled', TENTATIVE: 'Tentative' },
    todoStatus: { 'NEEDS-ACTION': 'Open', 'IN-PROCESS': 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled' },
    partstat: { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', DELEGATED: 'delegated' },
    role: { 'OPT-PARTICIPANT': 'optional', 'NON-PARTICIPANT': 'for information', CHAIR: 'chair' },
    cutype: { ROOM: 'room', RESOURCE: 'resource' },
    units: [['week', 'weeks'], ['day', 'days'], ['hour', 'hours'], ['minute', 'minutes'], ['second', 'seconds']],
    weekdays: { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' },
  },
};

// Windows time zone names (Outlook / Exchange) for the zones invitations
// most often carry. Anything else is shown as written.
const WINDOWS_ZONES = {
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

export function isCalendarFile(contentType, filename) {
  if (/\.(ics|ical)$/i.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return /^(text\/calendar|application\/ics)\b/i.test(contentType || '');
}

// ---------------------------------------------------------------- time zones

function isIanaZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function displayZone() {
  const tz = process.env.TZ;
  return isIanaZone(tz) ? tz : 'Europe/Berlin';
}

/** TZID -> IANA zone name, or null when it cannot be resolved. */
export function resolveZone(tzid) {
  const id = String(tzid || '').trim().replace(/^"|"$/g, '');
  if (!id) return null;
  if (id.includes('/') || id === 'UTC' || id === 'GMT') {
    // Plain IANA, or prefixed ones like /mozilla.org/20050126_1/Europe/Berlin
    const segs = id.split('/').filter(Boolean);
    for (let n = Math.min(3, segs.length); n >= 1; n--) {
      const candidate = segs.slice(-n).join('/');
      if ((n > 1 || candidate === 'UTC' || candidate === 'GMT') && isIanaZone(candidate)) return candidate;
    }
  }
  const win = WINDOWS_ZONES[id.toLowerCase()];
  return win || null;
}

const partsFormatters = new Map();

function wallClockMs(ms, tz) {
  let dtf = partsFormatters.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatters.set(tz, dtf);
  }
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

/** Local wall-clock fields in an IANA zone -> the real instant. */
export function zonedToInstant(f, tz) {
  const guess = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  let instant = guess - (wallClockMs(guess, tz) - guess);
  instant = guess - (wallClockMs(instant, tz) - instant);
  return new Date(instant);
}

// ---------------------------------------------------------------- dates

const DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?(Z)?)?$/i;

function locale(lang) {
  return lang === 'en' ? 'en-GB' : 'de-DE';
}

function formatDay(f, lang) {
  return new Date(Date.UTC(f.y, f.mo - 1, f.d)).toLocaleDateString(locale(lang), {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function formatWallClock(f, lang) {
  return new Date(Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s)).toLocaleString(locale(lang), {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/**
 * Parse a DATE / DATE-TIME property.
 * @returns {null|{allDay:boolean, f:object, instant:Date|null, tzid:string|null}}
 */
function parseDateProp(prop, defaultZone) {
  if (!prop) return null;
  const m = String(prop.raw).trim().match(DATE_RE);
  if (!m) return null;
  const f = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const allDay = !m[4] || (param(prop, 'VALUE') || '').toUpperCase() === 'DATE';
  if (allDay) return { allDay: true, f, instant: null, tzid: null };
  if (m[7]) return { allDay: false, f, instant: new Date(Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s)), tzid: null };
  const tzid = param(prop, 'TZID') || null;
  const zone = tzid ? resolveZone(tzid) : defaultZone;
  return { allDay: false, f, instant: zone ? zonedToInstant(f, zone) : null, tzid };
}

function showDate(dt, lang) {
  if (dt.allDay) return formatDay(dt.f, lang);
  if (dt.instant) return formatMailDate(dt.instant, lang);
  const local = formatWallClock(dt.f, lang);
  return dt.tzid ? `${local} (${dt.tzid})` : local;
}

function sortKey(dt) {
  if (!dt) return Infinity;
  if (dt.instant) return dt.instant.getTime();
  if (dt.allDay) return Date.UTC(dt.f.y, dt.f.mo - 1, dt.f.d);
  return zonedToInstant(dt.f, displayZone()).getTime();
}

function isoOf(dt) {
  if (!dt) return undefined;
  if (dt.instant) return dt.instant.toISOString();
  if (dt.tzid) return undefined;   // zone named but unknown: no honest instant
  const day = `${pad(dt.f.y, 4)}-${pad(dt.f.mo)}-${pad(dt.f.d)}`;
  return dt.allDay ? day : `${day}T${pad(dt.f.h)}:${pad(dt.f.mi)}:${pad(dt.f.s)}`;
}

function addDays(f, n) {
  const d = new Date(Date.UTC(f.y, f.mo - 1, f.d + n));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 0, mi: 0, s: 0 };
}

function dayNumber(f) {
  return Date.UTC(f.y, f.mo - 1, f.d) / 86400000;
}

/** "PT1H30M" -> { weeks, days, hours, minutes, seconds } or null. */
function parseDuration(s) {
  const m = String(s || '').trim().match(/^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m || m[0].length <= 1) return null;
  return { weeks: +(m[1] || 0), days: +(m[2] || 0), hours: +(m[3] || 0), minutes: +(m[4] || 0), seconds: +(m[5] || 0) };
}

function humanDuration(dur, L) {
  const values = [dur.weeks, dur.days, dur.hours, dur.minutes, dur.seconds];
  const parts = values.map((n, i) => (n ? `${n} ${L.units[i][n === 1 ? 0 : 1]}` : null)).filter(Boolean);
  return parts.join(' ') || `0 ${L.units[3][1]}`;
}

// ---------------------------------------------------------------- recurrence

function ordinal(n, lang) {
  if (lang === 'en') {
    if (n === -1) return 'last';
    if (n === -2) return 'second to last';
    if (n < 0) return `${-n}th to last`;
    const s = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return `${n}${s}`;
  }
  if (n === -1) return 'letzten';
  if (n === -2) return 'vorletzten';
  if (n < 0) return `${-n}.-letzten`;
  return `${n}.`;
}

function joinList(items, lang) {
  if (items.length <= 1) return items.join('');
  const and = lang === 'en' ? ' and ' : ' und ';
  return items.slice(0, -1).join(', ') + and + items[items.length - 1];
}

function monthName(m, lang) {
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleString(locale(lang), { month: 'long', timeZone: 'UTC' });
}

/** Short, human-readable RRULE; falls back to the raw rule for anything unusual. */
export function describeRrule(rule, lang, defaultZone) {
  const en = lang === 'en';
  const L = LABELS[en ? 'en' : 'de'];
  const raw = String(rule || '').trim();
  const fallback = `\`${raw}\``;
  const parts = {};
  for (const kv of raw.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
  }
  const supported = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
  if (Object.keys(parts).some((k) => !supported.has(k))) return fallback;

  const freq = (parts.FREQ || '').toUpperCase();
  const n = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1;
  if (!Number.isFinite(n) || n < 1) return fallback;
  const base = {
    DAILY: en ? ['daily', `every ${n} days`] : ['täglich', `alle ${n} Tage`],
    WEEKLY: en ? ['weekly', `every ${n} weeks`] : ['wöchentlich', `alle ${n} Wochen`],
    MONTHLY: en ? ['monthly', `every ${n} months`] : ['monatlich', `alle ${n} Monate`],
    YEARLY: en ? ['yearly', `every ${n} years`] : ['jährlich', `alle ${n} Jahre`],
  }[freq];
  if (!base) return fallback;
  let text = n === 1 ? base[0] : base[1];

  const byday = parts.BYDAY ? parts.BYDAY.split(',').map((s) => s.trim().toUpperCase().match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/)) : [];
  if (byday.some((m) => !m)) return fallback;
  const days = byday.map((m) => ({ ord: m[1] ? parseInt(m[1], 10) : null, name: L.weekdays[m[2]] }));
  const monthdays = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map((s) => parseInt(s, 10)) : [];
  const months = parts.BYMONTH ? parts.BYMONTH.split(',').map((s) => parseInt(s, 10)) : [];
  if (monthdays.some((d) => !Number.isFinite(d) || d === 0 || Math.abs(d) > 31)) return fallback;
  if (months.some((m) => !Number.isFinite(m) || m < 1 || m > 12)) return fallback;
  if (days.length && monthdays.length) return fallback;

  const withOrd = days.filter((d) => d.ord !== null);
  if (withOrd.length && withOrd.length !== days.length) return fallback;
  if (withOrd.length && !['MONTHLY', 'YEARLY'].includes(freq)) return fallback;
  if (days.length && !withOrd.length && !['DAILY', 'WEEKLY'].includes(freq)) return fallback;

  const monthText = joinList(months.map((m) => monthName(m, lang)), lang);
  const mdayText = joinList(monthdays.map((d) => (d < 0
    ? (en ? `the ${ordinal(d, lang)} day` : `${ordinal(d, lang)} Tag`)
    : (en ? (months.length ? `${d}` : `day ${d}`) : `${d}.`))), lang);

  if (days.length && !withOrd.length) {
    text += (en ? ' on ' : ' am ') + joinList(days.map((d) => d.name), lang);
  } else if (withOrd.length) {
    const dayText = joinList(days.map((d) => `${ordinal(d.ord, lang)} ${d.name}`), lang);
    text += en ? ` on the ${dayText}` : ` am ${dayText}`;
    if (months.length) text += en ? ` in ${monthText}` : ` im ${monthText}`;
  } else if (monthdays.length) {
    text += en ? ` on ${mdayText}` : ` am ${mdayText}`;
    if (months.length) text += ` ${monthText}`;
  } else if (months.length) {
    text += en ? ` in ${monthText}` : ` im ${monthText}`;
  }

  if (parts.COUNT) {
    const c = parseInt(parts.COUNT, 10);
    if (!Number.isFinite(c)) return fallback;
    text += en ? `, ${c} ${c === 1 ? 'time' : 'times'}` : `, ${c} Mal`;
  }
  if (parts.UNTIL) {
    const until = parseDateProp({ raw: parts.UNTIL, params: {} }, defaultZone);
    if (!until) return fallback;
    let day;
    if (until.instant) {
      day = until.instant.toLocaleDateString(locale(lang), { day: 'numeric', month: 'long', year: 'numeric', timeZone: defaultZone || displayZone() });
    } else {
      day = formatDay(until.f, lang);
    }
    text += en ? `, until ${day}` : `, bis ${day}`;
  }
  return text;
}

// ---------------------------------------------------------------- people, text

function person(prop) {
  if (!prop) return null;
  const addr = String(prop.value || '').trim().replace(/^mailto:/i, '');
  const name = (param(prop, 'CN') || '').trim();
  if (name && addr && name.toLowerCase() !== addr.toLowerCase()) return `${name} <${addr}>`;
  return addr || name || null;
}

function attendee(prop, L) {
  const who = person(prop);
  if (!who) return null;
  const notes = [];
  const cutype = (param(prop, 'CUTYPE') || '').toUpperCase();
  const role = (param(prop, 'ROLE') || '').toUpperCase();
  const partstat = (param(prop, 'PARTSTAT') || '').toUpperCase();
  if (L.cutype[cutype]) notes.push(L.cutype[cutype]);
  if (L.role[role]) notes.push(L.role[role]);
  if (L.partstat[partstat]) notes.push(L.partstat[partstat]);
  return notes.length ? `${who} (${notes.join(', ')})` : who;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

// Linear on hostile input: no lazy scan to a closing tag, and tags stop at
// the next '<' (/<[^>]*>/ rescans to the end for every unclosed '<').
function stripTags(html) {
  return decodeEntities(removeElements(html, ['script', 'style', 'head'])
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table)>/gi, '\n')
    .replace(/<[^<>]*>/g, ''));
}

function tidy(text) {
  return trimLineEnds(String(text).replace(/\r\n?/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HTML_HINT = /<(br|p|div|a|b|i|u|strong|em|ul|ol|li|span|html|body)\b[^<>]*>/i;

function htmlToMarkdown(html, options) {
  if (typeof options.htmlFragmentToMarkdown === 'function') {
    try { return options.htmlFragmentToMarkdown(html); } catch { /* fall back to stripping */ }
  }
  return stripTags(html);
}

function description(comp, options) {
  const text = getProp(comp, 'DESCRIPTION')?.value || '';
  if (text.trim()) return tidy(HTML_HINT.test(text) ? htmlToMarkdown(text, options) : text);
  const alt = getProps(comp, 'X-ALT-DESC').find((p) => /html/i.test(param(p, 'FMTTYPE') || ''));
  if (alt && alt.value.trim()) return tidy(htmlToMarkdown(alt.value, options));
  return '';
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- entries

function buildEntry(comp, ctx) {
  const { L, lang, zone } = ctx;
  const start = parseDateProp(getProp(comp, 'DTSTART'), zone);
  const fields = [];
  const add = (label, value) => { if (value) fields.push(`**${label}:** ${value}`); };

  const kindParts = [];
  if (L.kind[comp.name]) kindParts.push(L.kind[comp.name]);
  if (ctx.methodLabel && ctx.single) kindParts.push(ctx.methodLabel);
  add(L.type, kindParts.join(', '));

  const status = (getProp(comp, 'STATUS')?.value || '').trim().toUpperCase();
  if (comp.name === 'VTODO') add(L.status, L.todoStatus[status]);
  else if (comp.name === 'VEVENT') add(L.status, L.eventStatus[status]);

  if (start) {
    if (start.allDay) {
      const endProp = getProp(comp, comp.name === 'VTODO' ? 'DUE' : 'DTEND');
      const end = parseDateProp(endProp, zone);
      const dur = parseDuration(getProp(comp, 'DURATION')?.value);
      let last = start.f;
      if (end && end.allDay) last = addDays(end.f, -1);
      else if (dur && (dur.days || dur.weeks)) last = addDays(start.f, dur.weeks * 7 + dur.days - 1);
      if (dayNumber(last) > dayNumber(start.f)) {
        add(L.start, `${formatDay(start.f, lang)} (${L.allDay})`);
        add(L.end, formatDay(last, lang));
      } else {
        add(L.date, comp.name === 'VJOURNAL' ? formatDay(start.f, lang) : `${formatDay(start.f, lang)} (${L.allDay})`);
      }
    } else {
      add(comp.name === 'VJOURNAL' ? L.date : L.start, showDate(start, lang));
      const end = parseDateProp(getProp(comp, 'DTEND'), zone);
      const dur = parseDuration(getProp(comp, 'DURATION')?.value);
      if (end && comp.name === 'VEVENT') add(L.end, showDate(end, lang));
      else if (dur) add(L.duration, humanDuration(dur, L));
    }
  }
  if (comp.name === 'VTODO' && !(start && start.allDay)) {
    const due = parseDateProp(getProp(comp, 'DUE'), zone);
    if (due) add(L.due, showDate(due, lang));
  }

  add(L.location, oneLine(getProp(comp, 'LOCATION')?.value));
  const organizer = person(getProp(comp, 'ORGANIZER'));
  add(L.organizer, organizer);
  const attendees = getProps(comp, 'ATTENDEE').map((p) => attendee(p, L)).filter(Boolean);
  add(L.attendees, attendees.join(', '));

  const rrule = getProp(comp, 'RRULE');
  if (rrule) add(L.repeats, describeRrule(rrule.raw, lang, zone));

  const url = oneLine(getProp(comp, 'URL')?.value);
  add(L.url, url);
  const links = new Set();
  for (const name of ['X-MICROSOFT-SKYPETEAMSMEETINGURL', 'X-GOOGLE-CONFERENCE', 'CONFERENCE']) {
    for (const p of getProps(comp, name)) {
      const link = oneLine(p.value);
      if (/^https?:\/\//i.test(link) && link !== url) links.add(link);
    }
  }
  add(L.online, [...links].join(', '));

  const summary = oneLine(getProp(comp, 'SUMMARY')?.value) || L.untitled;
  return { summary, fields, body: description(comp, ctx.options), start, organizer, organizerName: organizerName(comp) };
}

function organizerName(comp) {
  const p = getProp(comp, 'ORGANIZER');
  if (!p) return undefined;
  return (param(p, 'CN') || '').trim() || String(p.value || '').replace(/^mailto:/i, '').trim() || undefined;
}

function renderSection(entry, level) {
  let md = `${'#'.repeat(level)} ${entry.summary}\n\n`;
  if (entry.fields.length) md += entry.fields.join('  \n') + '\n\n';
  if (entry.body) md += (entry.fields.length ? '---\n\n' : '') + entry.body + '\n\n';
  return md;
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]  filename, lang, htmlFragmentToMarkdown
 */
export async function extractCalendar(buffer, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'de';
  const L = LABELS[lang];
  const bytes = Buffer.from(buffer);
  if (bytes.subarray(0, 8192).includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) {
    throw unprocessable('This does not look like a calendar file. / Das sieht nicht nach einer Kalenderdatei aus.', 'not_calendar');
  }
  const root = parseVFormat(bytes);
  const comps = findComponents(root, ['VEVENT', 'VTODO', 'VJOURNAL']);
  if (!comps.length) {
    throw unprocessable('No calendar entries found (expected VEVENT or VTODO). / Keine Kalendereinträge gefunden (VEVENT oder VTODO erwartet).', 'not_calendar');
  }

  const cal = findComponents(root, ['VCALENDAR'])[0] || root;
  const method = (getProp(cal, 'METHOD')?.value || '').trim().toUpperCase();
  const methodLabel = L.method[method] || null;
  const wrZone = resolveZone(getProp(cal, 'X-WR-TIMEZONE')?.value);
  const single = comps.length === 1;
  const ctx = { L, lang, zone: wrZone, methodLabel, single, options };

  const entries = comps.map((c) => buildEntry(c, ctx));
  entries.sort((a, b) => sortKey(a.start) - sortKey(b.start));

  let title;
  let markdown;
  if (single) {
    title = entries[0].summary;
    markdown = renderSection(entries[0], 1);
  } else {
    title = oneLine(getProp(cal, 'X-WR-CALNAME')?.value) || filenameStem(options.filename) || L.calendar;
    markdown = `# ${title}\n\n`;
    if (methodLabel) markdown += `**${L.type}:** ${methodLabel}\n\n`;
    markdown += entries.map((e) => renderSection(e, 2)).join('');
  }
  markdown = trimEndChars(markdown, '\n') + '\n';

  const first = entries[0];
  return {
    markdown,
    title,
    source: 'calendar',
    metadata: {
      title,
      sourceUrl: null,
      author: first.organizerName,
      publishedTime: isoOf(first.start),
      contentLength: markdown.replace(/^# [^\n]*\n+/, '').trim().length,
    },
  };
}
