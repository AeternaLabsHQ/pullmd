// Contact files (.vcf / .vcard; vCard 2.1, 3.0 and 4.0) to Markdown: one
// section per card with name, organization, phone numbers, e-mail,
// addresses and the note as body. Photos, logos, sounds and keys are
// skipped.
import { parseVFormat, findComponents, getProp, getProps, param, splitStructured } from './vformat.js';
import { filenameStem, trimEndChars, trimLineEnds } from './text-decode.js';
import { unprocessable } from './mail-render.js';

const LABELS = {
  de: {
    org: 'Organisation', title: 'Position', phone: 'Telefon', email: 'E-Mail', address: 'Adresse',
    web: 'Web', birthday: 'Geburtstag', anniversary: 'Jahrestag', nickname: 'Spitzname', categories: 'Kategorien',
    noName: '(ohne Namen)', contacts: 'Kontakte',
    types: { CELL: 'mobil', HOME: 'privat', WORK: 'geschäftlich', FAX: 'Fax', PAGER: 'Pager', MAIN: 'Zentrale', IPHONE: 'iPhone' },
  },
  en: {
    org: 'Organization', title: 'Title', phone: 'Phone', email: 'E-mail', address: 'Address',
    web: 'Web', birthday: 'Birthday', anniversary: 'Anniversary', nickname: 'Nickname', categories: 'Categories',
    noName: '(no name)', contacts: 'Contacts',
    types: { CELL: 'mobile', HOME: 'home', WORK: 'work', FAX: 'fax', PAGER: 'pager', MAIN: 'main', IPHONE: 'iPhone' },
  },
};

export function isVcardFile(contentType, filename) {
  if (/\.(vcf|vcard)$/i.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return /^(text\/vcard|text\/x-vcard|text\/directory)\b/i.test(contentType || '');
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// group -> first X-ABLABEL property, built once per card (a lookup per
// property would be quadratic on cards with many grouped properties).
const labelIndexes = new WeakMap();

function labelIndex(card) {
  let index = labelIndexes.get(card);
  if (!index) {
    index = new Map();
    for (const p of card.props) {
      if (p.name === 'X-ABLABEL' && p.group != null && !index.has(p.group)) index.set(p.group, p);
    }
    labelIndexes.set(card, index);
  }
  return index;
}

/** Apple writes custom labels as itemN.X-ABLabel next to itemN.TEL. */
function appleLabel(card, prop) {
  if (!prop.group) return null;
  const label = labelIndex(card).get(prop.group);
  if (!label) return null;
  return oneLine(label.value.replace(/^_\$!<(.*)>!\$_$/, '$1')) || null;
}

function typeLabels(card, prop, L) {
  const custom = appleLabel(card, prop);
  if (custom) return [custom];
  const types = (prop.params.TYPE || [])
    .flatMap((t) => String(t).split(','))
    .map((t) => t.trim().toUpperCase());
  const out = [];
  for (const t of types) {
    const label = L.types[t];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

function withTypes(value, labels) {
  return labels.length ? `${value} (${labels.join(', ')})` : value;
}

function cardName(card) {
  const fn = oneLine(getProp(card, 'FN')?.value);
  if (fn) return fn;
  const n = getProp(card, 'N');
  if (n) {
    // family; given; additional; prefixes; suffixes
    const [family, given, additional, prefix, suffix] = splitStructured(n.raw, ';').map(oneLine);
    const name = [prefix, given, additional, family, suffix].filter(Boolean).join(' ');
    if (name) return name;
  }
  return null;
}

function formatAddress(prop) {
  // PO box; extended; street; locality; region; postal code; country
  const [pobox, ext, street, locality, region, code, country] = splitStructured(prop.raw, ';')
    .map((s) => s.split(/\n/).map(oneLine).filter(Boolean).join(', '));
  const city = [code, locality].filter(Boolean).join(' ');
  return [pobox, ext, street, city, region, country].filter(Boolean).join(', ');
}

/** BDAY / ANNIVERSARY: 19850412, 1985-04-12, --0412, --04-12, 1985-04-12T00:00:00Z */
export function formatVcardDate(value, lang) {
  const s = String(value || '').trim();
  const locale = lang === 'en' ? 'en-GB' : 'de-DE';
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString(locale, {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  }
  m = s.match(/^--(\d{2})-?(\d{2})$/);
  if (m) {
    return new Date(Date.UTC(2000, +m[1] - 1, +m[2])).toLocaleDateString(locale, {
      day: 'numeric', month: 'long', timeZone: 'UTC',
    });
  }
  return s || null;
}

function renderCard(card, L, lang) {
  const fields = [];
  const add = (label, value) => { if (value) fields.push(`**${label}:** ${value}`); };

  const orgs = getProps(card, 'ORG').map((p) => splitStructured(p.raw, ';').map(oneLine).filter(Boolean).join(', ')).filter(Boolean);
  add(L.org, orgs.join('; '));

  const positions = new Set();
  for (const name of ['TITLE', 'ROLE']) {
    for (const p of getProps(card, name)) {
      const v = oneLine(p.value);
      if (v) positions.add(v);
    }
  }
  add(L.title, [...positions].join(', '));

  const phones = getProps(card, 'TEL')
    .map((p) => {
      const v = oneLine(p.value).replace(/^tel:/i, '');
      return v ? withTypes(v, typeLabels(card, p, L)) : null;
    })
    .filter(Boolean);
  add(L.phone, phones.join(', '));

  const emails = getProps(card, 'EMAIL')
    .map((p) => {
      const v = oneLine(p.value).replace(/^mailto:/i, '');
      return v ? withTypes(v, typeLabels(card, p, L)) : null;
    })
    .filter(Boolean);
  add(L.email, emails.join(', '));

  const addresses = getProps(card, 'ADR')
    .map((p) => {
      const v = formatAddress(p);
      return v ? withTypes(v, typeLabels(card, p, L)) : null;
    })
    .filter(Boolean);
  if (addresses.length === 1) add(L.address, addresses[0]);
  else if (addresses.length > 1) add(L.address, addresses.join('; '));

  add(L.web, getProps(card, 'URL').map((p) => oneLine(p.value)).filter(Boolean).join(', '));

  const bday = getProp(card, 'BDAY');
  if (bday) add(L.birthday, formatVcardDate(bday.value, lang));
  const anniversary = getProp(card, 'ANNIVERSARY');
  if (anniversary) add(L.anniversary, formatVcardDate(anniversary.value, lang));

  const nicknames = getProps(card, 'NICKNAME').flatMap((p) => splitStructured(p.raw, ',')).map(oneLine).filter(Boolean);
  add(L.nickname, nicknames.join(', '));
  const categories = getProps(card, 'CATEGORIES').flatMap((p) => splitStructured(p.raw, ',')).map(oneLine).filter(Boolean);
  add(L.categories, categories.join(', '));

  const note = getProps(card, 'NOTE')
    .map((p) => trimLineEnds(p.value.replace(/\r\n?/g, '\n')).replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean)
    .join('\n\n');

  const name = cardName(card) || orgs[0] || emails[0]?.replace(/ \(.*\)$/, '') || L.noName;
  return { name, fields, note };
}

function renderSection(entry, level) {
  let md = `${'#'.repeat(level)} ${entry.name}\n\n`;
  if (entry.fields.length) md += entry.fields.join('  \n') + '\n\n';
  if (entry.note) md += (entry.fields.length ? '---\n\n' : '') + entry.note + '\n\n';
  return md;
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]  filename, lang
 */
export async function extractVcard(buffer, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'de';
  const L = LABELS[lang];
  const bytes = Buffer.from(buffer);
  if (bytes.subarray(0, 8192).includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) {
    throw unprocessable('This does not look like a contact file. / Das sieht nicht nach einer Kontaktdatei aus.', 'not_vcard');
  }
  const cards = findComponents(parseVFormat(bytes), ['VCARD']);
  if (!cards.length) {
    throw unprocessable('No contacts found (expected BEGIN:VCARD). / Keine Kontakte gefunden (BEGIN:VCARD erwartet).', 'not_vcard');
  }
  const entries = cards.map((c) => renderCard(c, L, lang));

  let title;
  let markdown;
  if (entries.length === 1) {
    title = entries[0].name;
    markdown = renderSection(entries[0], 1);
  } else {
    title = filenameStem(options.filename) || L.contacts;
    markdown = `# ${title}\n\n` + entries.map((e) => renderSection(e, 2)).join('');
  }
  markdown = trimEndChars(markdown, '\n') + '\n';

  return {
    markdown,
    title,
    source: 'contact',
    metadata: {
      title,
      sourceUrl: null,
      contentLength: markdown.replace(/^# [^\n]*\n+/, '').trim().length,
    },
  };
}
