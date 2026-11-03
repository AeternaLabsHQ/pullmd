import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseVFormat, findComponents, getProp } from '../lib/vformat.js';
import { extractCalendar, isCalendarFile, describeRrule, resolveZone, zonedToInstant } from '../lib/calendar.js';
import { extractVcard, isVcardFile, formatVcardDate } from '../lib/vcard.js';

before(() => { process.env.TZ = 'Europe/Berlin'; });

const crlf = (...lines) => Buffer.from(lines.join('\r\n') + '\r\n');
const cal = (...body) => crlf('BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Test//EN', ...body, 'END:VCALENDAR');
// Locale output may use narrow no-break spaces; match any whitespace.
const S = '\\s';

// ---------------------------------------------------------------- vformat

describe('vformat content lines', () => {
  it('keeps colons and commas inside quoted parameter values', () => {
    const root = parseVFormat(cal('BEGIN:VEVENT', 'ORGANIZER;CN="Doe: Jane, PhD";ROLE=CHAIR:mailto:jane@example.com', 'END:VEVENT'));
    const ev = findComponents(root, ['VEVENT'])[0];
    const org = getProp(ev, 'ORGANIZER');
    assert.deepEqual(org.params.CN, ['Doe: Jane, PhD']);
    assert.equal(org.value, 'mailto:jane@example.com');
  });

  it('unfolds a fold that splits a multi-byte UTF-8 sequence', () => {
    const ue = Buffer.from('ü');
    const buf = Buffer.concat([
      Buffer.from('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Gr'), ue.subarray(0, 1),
      Buffer.from('\r\n '), ue.subarray(1), Buffer.from('ne Wiese\\, M\r\n\tarkt\\; Stand\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'),
    ]);
    const ev = findComponents(parseVFormat(buf), ['VEVENT'])[0];
    assert.equal(getProp(ev, 'SUMMARY').value, 'Grüne Wiese, Markt; Stand');
  });

  it('strips group prefixes, uppercases names and maps vCard 2.1 bare params to TYPE', () => {
    const root = parseVFormat(crlf('BEGIN:VCARD', 'item1.tel;HOME;VOICE:123', 'END:VCARD'));
    const p = root.children[0].props[0];
    assert.equal(p.name, 'TEL');
    assert.equal(p.group, 'item1');
    assert.deepEqual(p.params.TYPE, ['HOME', 'VOICE']);
  });

  it('builds nested components and keeps VALARM props out of the event', () => {
    const root = parseVFormat(cal('BEGIN:VEVENT', 'SUMMARY:Outer', 'BEGIN:VALARM', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT'));
    const ev = findComponents(root, ['VEVENT'])[0];
    assert.equal(getProp(ev, 'DESCRIPTION'), null);
    assert.equal(ev.children[0].name, 'VALARM');
  });
});

// ---------------------------------------------------------------- calendar

describe('calendar detection', () => {
  it('detects by extension, then by content type without extension', () => {
    assert.equal(isCalendarFile('application/octet-stream', 'invite.ICS'), true);
    assert.equal(isCalendarFile('', 'export.ical'), true);
    assert.equal(isCalendarFile('text/calendar; method=REQUEST', ''), true);
    assert.equal(isCalendarFile('text/calendar', 'notes.txt'), false);
    assert.equal(isCalendarFile('text/plain', 'x'), false);
  });
});

describe('time zones', () => {
  it('resolves IANA, prefixed IANA and Windows zone names', () => {
    assert.equal(resolveZone('Europe/Berlin'), 'Europe/Berlin');
    assert.equal(resolveZone('/mozilla.org/20050126_1/Europe/Berlin'), 'Europe/Berlin');
    assert.equal(resolveZone('W. Europe Standard Time'), 'Europe/Berlin');
    assert.equal(resolveZone('Pacific Standard Time'), 'America/Los_Angeles');
    assert.equal(resolveZone('Custom Zone 7'), null);
  });

  it('converts local wall-clock time to the real instant across DST', () => {
    const f = (mo, h) => ({ y: 2026, mo, d: 15, h, mi: 0, s: 0 });
    assert.equal(zonedToInstant(f(1, 10), 'Europe/Berlin').toISOString(), '2026-01-15T09:00:00.000Z');
    assert.equal(zonedToInstant(f(7, 10), 'Europe/Berlin').toISOString(), '2026-07-15T08:00:00.000Z');
    assert.equal(zonedToInstant(f(7, 10), 'America/New_York').toISOString(), '2026-07-15T14:00:00.000Z');
  });
});

const OUTLOOK = cal(
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Jana Beispiel:MAILTO:jana@example.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Max Muster:mailto:max@example.com',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Eva Probe:mailto:eva@example.com',
  'DESCRIPTION;LANGUAGE=de-DE:Hallo zusammen\\,\\n\\nbitte Unterlagen mitbringen.\\n',
  'SUMMARY;LANGUAGE=de-DE:Projektbesprechung Q4',
  'DTSTART;TZID=W. Europe Standard Time:20261105T140000',
  'DTEND;TZID=W. Europe Standard Time:20261105T153000',
  'UID:040000008200E00074C5B7101A82E00800000000@example.com',
  'LOCATION;LANGUAGE=de-DE:Raum 4.12',
  'STATUS:CONFIRMED',
  'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.example.com/l/meetup-join/abc',
  'END:VEVENT',
);

describe('Outlook invitation', () => {
  it('renders an invitation with Windows TZID, attendees and Teams link (de)', async () => {
    const r = await extractCalendar(OUTLOOK, { filename: 'invite.ics', lang: 'de' });
    assert.equal(r.source, 'calendar');
    assert.equal(r.title, 'Projektbesprechung Q4');
    assert.ok(r.markdown.startsWith('# Projektbesprechung Q4\n\n'));
    assert.match(r.markdown, /\*\*Art:\*\* Einladung/);
    assert.match(r.markdown, new RegExp(`\\*\\*Beginn:\\*\\* 5\\. November 2026 um${S}14:00${S}MEZ`));
    assert.match(r.markdown, new RegExp(`\\*\\*Ende:\\*\\* 5\\. November 2026 um${S}15:30${S}MEZ`));
    assert.match(r.markdown, /\*\*Ort:\*\* Raum 4\.12/);
    assert.match(r.markdown, /\*\*Organisator:\*\* Jana Beispiel <jana@example\.com>/);
    assert.match(r.markdown, /\*\*Teilnehmer:\*\* Max Muster <max@example\.com>, Eva Probe <eva@example\.com> \(optional, zugesagt\)/);
    assert.match(r.markdown, /\*\*Online-Meeting:\*\* https:\/\/teams\.example\.com\/l\/meetup-join\/abc/);
    assert.match(r.markdown, /---\n\nHallo zusammen,\n\nbitte Unterlagen mitbringen\.\n$/);
    assert.ok(!r.markdown.includes('Status'), 'CONFIRMED is not worth a line');
    assert.equal(r.metadata.publishedTime, '2026-11-05T13:00:00.000Z');
    assert.equal(r.metadata.author, 'Jana Beispiel');
    assert.ok(r.metadata.contentLength > 0);
  });

  it('uses English labels', async () => {
    const r = await extractCalendar(OUTLOOK, { lang: 'en' });
    assert.match(r.markdown, /\*\*Type:\*\* Invitation/);
    assert.match(r.markdown, new RegExp(`\\*\\*Start:\\*\\* 5 November 2026 at${S}14:00${S}CET`));
    assert.match(r.markdown, /\*\*Location:\*\* Raum 4\.12/);
    assert.match(r.markdown, /\*\*Attendees:\*\* .*\(optional, accepted\)/);
    assert.match(r.markdown, /\*\*Online meeting:\*\* https:/);
  });

  it('shows an unknown TZID as written', async () => {
    const r = await extractCalendar(cal('BEGIN:VEVENT', 'SUMMARY:X', 'DTSTART;TZID="Custom Zone 7":20261105T140000', 'END:VEVENT'), { lang: 'de' });
    assert.match(r.markdown, new RegExp(`\\*\\*Beginn:\\*\\* 5\\. November 2026 um${S}14:00 \\(Custom Zone 7\\)`));
    assert.equal(r.metadata.publishedTime, undefined);
  });
});

describe('Google invitation', () => {
  it('formats UTC times in the display zone and lists the Meet link', async () => {
    const ics = cal(
      'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'DTSTART:20260710T080000Z', 'DTEND:20260710T090000Z',
      'ORGANIZER;CN=team@example.com:mailto:team@example.com',
      'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=TENTATIVE;CN=kim@example.com;X-NUM-GUESTS=0:mailto:kim@example.com',
      'X-GOOGLE-CONFERENCE:https://meet.example.com/abc-defg-hij',
      'DESCRIPTION:Agenda:<br><ul><li>Punkt eins</li><li>Punkt zwei</li></ul>',
      'SUMMARY:Sprint-Review',
      'END:VEVENT',
    );
    const r = await extractCalendar(ics, { lang: 'de' });
    assert.match(r.markdown, new RegExp(`\\*\\*Beginn:\\*\\* 10\\. Juli 2026 um${S}10:00${S}MESZ`));
    assert.match(r.markdown, /\*\*Organisator:\*\* team@example\.com\s/);
    assert.match(r.markdown, /\*\*Teilnehmer:\*\* kim@example\.com \(vorläufig\)/);
    assert.match(r.markdown, /\*\*Online-Meeting:\*\* https:\/\/meet\.example\.com\/abc-defg-hij/);
    assert.match(r.markdown, /Agenda:\n+- Punkt eins\n- Punkt zwei/);
    assert.ok(!r.markdown.includes('<li>'));
  });

  it('passes HTML descriptions to an injected converter', async () => {
    const ics = cal('BEGIN:VEVENT', 'SUMMARY:Y', 'DTSTART:20260710T080000Z', 'DESCRIPTION:<b>fett</b>', 'END:VEVENT');
    const r = await extractCalendar(ics, { htmlFragmentToMarkdown: (h) => `CONVERTED(${h})` });
    assert.match(r.markdown, /CONVERTED\(<b>fett<\/b>\)/);
  });

  it('falls back to X-ALT-DESC when DESCRIPTION is empty', async () => {
    const ics = cal('BEGIN:VEVENT', 'SUMMARY:Y', 'DTSTART:20260710T080000Z', 'DESCRIPTION:',
      'X-ALT-DESC;FMTTYPE=text/html:<html><body><p>Hallo &amp; willkommen</p></body></html>', 'END:VEVENT');
    const r = await extractCalendar(ics, {});
    assert.match(r.markdown, /---\n\nHallo & willkommen\n$/);
  });
});

describe('Apple invitation', () => {
  it('resolves TZID=Europe/Berlin (with VTIMEZONE) and a summer time', async () => {
    const ics = cal(
      'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'DTSTART:19810329T020000', 'TZNAME:MESZ', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'DTSTART:19961027T030000', 'TZNAME:MEZ', 'TZOFFSETTO:+0100', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'DTSTART;TZID=Europe/Berlin:20260815T193000', 'DTEND;TZID=Europe/Berlin:20260815T220000',
      'SUMMARY:Sommerfest', 'LOCATION:Gartenweg 3\\, 12345 Musterstadt', 'URL;VALUE=URI:https://example.com/fest',
      'END:VEVENT',
    );
    const r = await extractCalendar(ics, { lang: 'de' });
    assert.match(r.markdown, new RegExp(`\\*\\*Beginn:\\*\\* 15\\. August 2026 um${S}19:30${S}MESZ`));
    assert.match(r.markdown, new RegExp(`\\*\\*Ende:\\*\\* 15\\. August 2026 um${S}22:00${S}MESZ`));
    assert.match(r.markdown, /\*\*Ort:\*\* Gartenweg 3, 12345 Musterstadt/);
    assert.match(r.markdown, /\*\*URL:\*\* https:\/\/example\.com\/fest/);
    assert.equal(r.metadata.publishedTime, '2026-08-15T17:30:00.000Z');
    assert.ok(!r.markdown.includes('---'), 'no body, no separator');
  });
});

describe('all-day events', () => {
  it('shows the inclusive last day for multi-day events', async () => {
    const r = await extractCalendar(cal('BEGIN:VEVENT', 'SUMMARY:Messe', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261113', 'END:VEVENT'), { lang: 'de' });
    assert.match(r.markdown, /\*\*Beginn:\*\* 10\. November 2026 \(ganztägig\)  \n\*\*Ende:\*\* 12\. November 2026/);
    assert.equal(r.metadata.publishedTime, '2026-11-10');
  });

  it('shows a single date for one-day events', async () => {
    const r = await extractCalendar(cal('BEGIN:VEVENT', 'SUMMARY:Feiertag', 'DTSTART;VALUE=DATE:20261003', 'DTEND;VALUE=DATE:20261004', 'END:VEVENT'), { lang: 'en' });
    assert.match(r.markdown, /\*\*Date:\*\* 3 October 2026 \(all day\)/);
    assert.ok(!r.markdown.includes('**End:**'));
  });
});

describe('recurrence', () => {
  it('describes common rules in both languages', () => {
    assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,WE', 'de'), 'wöchentlich am Montag und Mittwoch');
    assert.equal(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=10', 'en'), 'every 2 weeks on Friday, 10 times');
    assert.equal(describeRrule('FREQ=MONTHLY;BYDAY=-1FR', 'de'), 'monatlich am letzten Freitag');
    assert.equal(describeRrule('FREQ=MONTHLY;BYDAY=1MO', 'en'), 'monthly on the 1st Monday');
    assert.equal(describeRrule('FREQ=MONTHLY;BYMONTHDAY=15', 'de'), 'monatlich am 15.');
    assert.equal(describeRrule('FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'en'), 'yearly on the last Sunday in March');
    assert.equal(describeRrule('FREQ=DAILY;UNTIL=20261231', 'de'), 'täglich, bis 31. Dezember 2026');
    assert.equal(describeRrule('FREQ=DAILY;UNTIL=20261231T225959Z', 'en'), 'daily, until 31 December 2026');
    assert.equal(describeRrule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', 'de'), '`FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1`');
  });

  it('renders the rule in the event', async () => {
    const r = await extractCalendar(cal('BEGIN:VEVENT', 'SUMMARY:Jour fixe', 'DTSTART:20261102T090000Z', 'DURATION:PT30M',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261221T090000Z', 'END:VEVENT'), { lang: 'de' });
    assert.match(r.markdown, /\*\*Wiederholung:\*\* wöchentlich am Montag, bis 21\. Dezember 2026/);
    assert.match(r.markdown, /\*\*Dauer:\*\* 30 Minuten/);
  });
});

describe('cancellations', () => {
  it('marks a cancelled event', async () => {
    const ics = cal('METHOD:CANCEL', 'BEGIN:VEVENT', 'SUMMARY:Abgesagt: Workshop', 'STATUS:CANCELLED', 'DTSTART:20261120T100000Z', 'END:VEVENT');
    const de = await extractCalendar(ics, { lang: 'de' });
    assert.match(de.markdown, /\*\*Art:\*\* Absage  \n\*\*Status:\*\* Abgesagt/);
    const en = await extractCalendar(ics, { lang: 'en' });
    assert.match(en.markdown, /\*\*Type:\*\* Cancellation  \n\*\*Status:\*\* Cancelled/);
  });
});

describe('multiple entries', () => {
  it('sorts by start under the calendar name, with tasks', async () => {
    const ics = cal(
      'X-WR-CALNAME:Team-Kalender',
      'BEGIN:VEVENT', 'SUMMARY:Später', 'DTSTART:20261201T090000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Früher', 'DTSTART;TZID=Europe/Berlin:20261105T090000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Ganztags', 'DTSTART;VALUE=DATE:20261110', 'END:VEVENT',
      'BEGIN:VTODO', 'SUMMARY:Bericht schreiben', 'DUE:20261108T170000Z', 'STATUS:NEEDS-ACTION', 'END:VTODO',
    );
    const r = await extractCalendar(ics, { lang: 'de', filename: 'export.ics' });
    assert.equal(r.title, 'Team-Kalender');
    assert.ok(r.markdown.startsWith('# Team-Kalender\n\n## Früher\n'));
    const order = [...r.markdown.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    assert.deepEqual(order, ['Früher', 'Ganztags', 'Später', 'Bericht schreiben']);
    assert.match(r.markdown, /## Bericht schreiben\n\n\*\*Art:\*\* Aufgabe  \n\*\*Status:\*\* Offen  \n\*\*Fällig:\*\* 8\. November 2026/);
  });

  it('falls back to the file name for the heading', async () => {
    const ics = cal('BEGIN:VEVENT', 'SUMMARY:A', 'END:VEVENT', 'BEGIN:VEVENT', 'SUMMARY:B', 'END:VEVENT');
    const r = await extractCalendar(ics, { filename: 'Termine 2026.ics' });
    assert.ok(r.markdown.startsWith('# Termine 2026\n\n## A\n'));
  });
});

describe('calendar errors', () => {
  it('rejects files without entries and binary junk with 422', async () => {
    await assert.rejects(() => extractCalendar(cal('BEGIN:VTIMEZONE', 'TZID:UTC', 'END:VTIMEZONE')), (e) => e.status === 422 && e.code === 'not_calendar');
    await assert.rejects(() => extractCalendar(Buffer.from('just some text\nnothing here')), (e) => e.status === 422 && /Keine Kalendereinträge/.test(e.message));
    await assert.rejects(() => extractCalendar(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 1, 2])), (e) => e.status === 422);
  });
});

// ---------------------------------------------------------------- vCard

describe('vCard detection', () => {
  it('detects by extension and content type', () => {
    assert.equal(isVcardFile('', 'kontakt.VCF'), true);
    assert.equal(isVcardFile('', 'a.vcard'), true);
    assert.equal(isVcardFile('text/x-vcard', ''), true);
    assert.equal(isVcardFile('text/directory; profile=vCard', ''), true);
    assert.equal(isVcardFile('text/vcard', 'a.txt'), false);
  });

  it('formats birthdays with and without year', () => {
    assert.equal(formatVcardDate('19850412', 'de'), '12. April 1985');
    assert.equal(formatVcardDate('1985-04-12', 'en'), '12 April 1985');
    assert.equal(formatVcardDate('--0412', 'de'), '12. April');
    assert.equal(formatVcardDate('--04-12', 'en'), '12 April');
    assert.equal(formatVcardDate('1985-04-12T00:00:00Z', 'de'), '12. April 1985');
  });
});

const VCARD3 = crlf(
  'BEGIN:VCARD', 'VERSION:3.0',
  'N:Beispiel;Jana;;Dr.;', 'FN:Dr. Jana Beispiel',
  'ORG:Beispiel GmbH;Entwicklung', 'TITLE:Teamleiterin',
  'TEL;TYPE=CELL:+49 170 0000000', 'TEL;TYPE=WORK,VOICE:+49 30 0000000', 'TEL;TYPE=WORK,FAX:+49 30 0000001',
  'EMAIL;TYPE=INTERNET,WORK:jana@example.com',
  'ADR;TYPE=WORK:;;Musterstraße 1;Musterstadt;;12345;Deutschland',
  'URL:https://example.com', 'BDAY:1985-04-12', 'NICKNAME:Jay,JB',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQ',
  ' DQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQU',
  'NOTE:Erreichbar Mo-Fr\\, 9-17 Uhr.\\nBitte vorher mailen.',
  'END:VCARD',
);

describe('vCard 3.0', () => {
  it('renders fields in German', async () => {
    const r = await extractVcard(VCARD3, { lang: 'de', filename: 'jana.vcf' });
    assert.equal(r.source, 'contact');
    assert.equal(r.title, 'Dr. Jana Beispiel');
    assert.equal(r.markdown, [
      '# Dr. Jana Beispiel',
      '',
      '**Organisation:** Beispiel GmbH, Entwicklung  ',
      '**Position:** Teamleiterin  ',
      '**Telefon:** +49 170 0000000 (mobil), +49 30 0000000 (geschäftlich), +49 30 0000001 (geschäftlich, Fax)  ',
      '**E-Mail:** jana@example.com (geschäftlich)  ',
      '**Adresse:** Musterstraße 1, 12345 Musterstadt, Deutschland (geschäftlich)  ',
      '**Web:** https://example.com  ',
      '**Geburtstag:** 12. April 1985  ',
      '**Spitzname:** Jay, JB',
      '',
      '---',
      '',
      'Erreichbar Mo-Fr, 9-17 Uhr.',
      'Bitte vorher mailen.',
      '',
    ].join('\n'));
    assert.ok(!r.markdown.includes('9j/4AAQ'));
  });

  it('renders English labels', async () => {
    const r = await extractVcard(VCARD3, { lang: 'en' });
    assert.match(r.markdown, /\*\*Organization:\*\* Beispiel GmbH, Entwicklung/);
    assert.match(r.markdown, /\*\*Phone:\*\* \+49 170 0000000 \(mobile\), \+49 30 0000000 \(work\)/);
    assert.match(r.markdown, /\*\*Birthday:\*\* 12 April 1985/);
    assert.match(r.markdown, /\*\*Nickname:\*\* Jay, JB/);
  });
});

describe('vCard 4.0', () => {
  it('handles tel: URIs, quoted TYPE lists, --MMDD birthdays and assembled N', async () => {
    const vcf = crlf(
      'BEGIN:VCARD', 'VERSION:4.0',
      'N:Muster;Max;;;',
      'TEL;VALUE=uri;TYPE="voice,home":tel:+49-30-1234567',
      'EMAIL;TYPE=home:max@example.com',
      'BDAY:--0412',
      'item1.TEL:+49 40 7654321', 'item1.X-ABLabel:_$!<Assistant>!$_',
      'END:VCARD',
    );
    const r = await extractVcard(vcf, { lang: 'de' });
    assert.ok(r.markdown.startsWith('# Max Muster\n\n'));
    assert.match(r.markdown, /\*\*Telefon:\*\* \+49-30-1234567 \(privat\), \+49 40 7654321 \(Assistant\)/);
    assert.match(r.markdown, /\*\*E-Mail:\*\* max@example\.com \(privat\)/);
    assert.match(r.markdown, /\*\*Geburtstag:\*\* 12\. April\s/);
  });
});

describe('vCard 2.1', () => {
  it('decodes quoted-printable with umlauts and a soft line break', async () => {
    const vcf = crlf(
      'BEGIN:VCARD', 'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller',
      'TEL;CELL;VOICE:+49 151 0000000',
      'ADR;HOME;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:;;Hauptstra=DFe 5;K=F6ln;;50667;',
      'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Gr=C3=BC=C3=9Fe aus dem B=C3=BCro, sehr lange Zeile die umbr=',
      'ochen wird=0D=0AZweite Zeile',
      'END:VCARD',
    );
    const r = await extractVcard(vcf, { lang: 'de' });
    assert.ok(r.markdown.startsWith('# Jürgen Müller\n\n'));
    assert.match(r.markdown, /\*\*Telefon:\*\* \+49 151 0000000 \(mobil\)/);
    assert.match(r.markdown, /\*\*Adresse:\*\* Hauptstraße 5, 50667 Köln \(privat\)/);
    assert.match(r.markdown, /---\n\nGrüße aus dem Büro, sehr lange Zeile die umbrochen wird\nZweite Zeile\n$/);
  });
});

describe('multiple cards', () => {
  it('lists cards in file order under the file name', async () => {
    const vcf = crlf(
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Zoe Zett', 'EMAIL:zoe@example.com', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Anna Ahorn', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'ORG:Nur Firma AG', 'END:VCARD',
    );
    const r = await extractVcard(vcf, { lang: 'en', filename: 'Adressbuch.vcf' });
    assert.equal(r.title, 'Adressbuch');
    assert.deepEqual([...r.markdown.matchAll(/^#+ (.*)$/gm)].map((m) => m[1]), ['Adressbuch', 'Zoe Zett', 'Anna Ahorn', 'Nur Firma AG']);
    assert.match(r.markdown, /## Anna Ahorn\n\n## Nur Firma AG\n\n\*\*Organization:\*\* Nur Firma AG\n$/);
  });
});

describe('vCard errors', () => {
  it('rejects non-vCard input with 422', async () => {
    await assert.rejects(() => extractVcard(Buffer.from('Name,Phone\nA,1\n')), (e) => e.status === 422 && e.code === 'not_vcard');
    await assert.rejects(() => extractVcard(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d])), (e) => e.status === 422);
    await assert.rejects(() => extractVcard(cal('BEGIN:VEVENT', 'SUMMARY:x', 'END:VEVENT')), (e) => /Keine Kontakte/.test(e.message));
  });
});

describe('hostile calendar and contact input', () => {
  const timed = async (fn) => {
    const t0 = Date.now();
    const out = await fn();
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `took ${ms} ms`);
    return out;
  };

  it('joins many quoted-printable soft line breaks in linear time', async () => {
    const r = await timed(() => extractVcard(Buffer.from(`BEGIN:VCARD\nFN:x\nNOTE;ENCODING=QUOTED-PRINTABLE:${'a=\n'.repeat(200000)}b\nEND:VCARD\n`), { filename: 'a.vcf' }));
    assert.ok(r.markdown.includes(`${'a'.repeat(200000)}b`));
  });

  it('bounds component nesting', async () => {
    const deep = 'BEGIN:X\n'.repeat(100000) + 'END:Y\n'.repeat(100000);
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Tief\nDTSTART:20260101T100000Z\nEND:VEVENT\n${deep}END:VCALENDAR\n`;
    const r = await timed(() => extractCalendar(Buffer.from(ics), { filename: 'a.ics' }));
    assert.match(r.markdown, /^# Tief/);
    const root = parseVFormat('BEGIN:A\n'.repeat(1000) + 'END:A\n'.repeat(1000));
    let depth = 0;
    for (let n = root; n.children.length; n = n.children[0]) depth++;
    assert.ok(depth <= 64);
  });

  it('strips hostile HTML descriptions in linear time', async () => {
    const desc = `<b>a${' '.repeat(100000)}x${'<li'.repeat(50000)}${'<script>'.repeat(30000)}`;
    const ics = cal('BEGIN:VEVENT', 'SUMMARY:x', 'DTSTART:20260101T100000Z', `DESCRIPTION:${desc}`, 'END:VEVENT');
    const r = await timed(() => extractCalendar(ics, { filename: 'a.ics' }));
    assert.match(r.markdown, /^# x/);
  });

  it('dedupes many meeting links in linear time', async () => {
    const links = Array.from({ length: 50000 }, (_, i) => `CONFERENCE:https://meet.example/${i % 25000}`);
    const ics = cal('BEGIN:VEVENT', 'SUMMARY:x', 'DTSTART:20260101T100000Z', ...links, 'END:VEVENT');
    const r = await timed(() => extractCalendar(ics, { filename: 'a.ics' }));
    assert.equal((r.markdown.match(/https:\/\/meet\.example\//g) || []).length, 25000);
  });

  it('looks up Apple labels and positions in linear time', async () => {
    const lines = ['BEGIN:VCARD', 'FN:Viele'];
    for (let i = 0; i < 30000; i++) lines.push(`item${i}.TEL:${i}`, `item${i}.X-ABLabel:L${i}`, `TITLE:T${i % 15000}`);
    lines.push('END:VCARD');
    const r = await timed(() => extractVcard(crlf(...lines), { filename: 'a.vcf' }));
    assert.match(r.markdown, /29999 \(L29999\)/);
    assert.ok(r.markdown.includes('T14999'));
    assert.equal((r.markdown.match(/T14999/g) || []).length, 1);
  });

  it('reads a parameter with 150000 values', async () => {
    const r = await timed(() => extractVcard(Buffer.from(`BEGIN:VCARD\nFN:x\nTEL;TYPE=${'a,'.repeat(150000)}CELL:1\nEND:VCARD\n`), { filename: 'a.vcf', lang: 'en' }));
    assert.match(r.markdown, /1 \(mobile\)/);
  });

  it('trims a note with a long blank run in linear time', async () => {
    const r = await timed(() => extractVcard(Buffer.from(`BEGIN:VCARD\nFN:x\nNOTE:a${' '.repeat(200000)}b\nEND:VCARD\n`), { filename: 'a.vcf' }));
    assert.ok(r.markdown.includes(`a${' '.repeat(200000)}b`));
  });
});
