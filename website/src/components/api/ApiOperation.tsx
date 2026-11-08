import React, { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import CodeBlock from '@theme/CodeBlock';
import Link from '@docusaurus/Link';
import { snippets, type Op, type Schema, type Param } from './snippets';

/* ---------- helpers ---------- */
function typeLabel(s?: Schema): string {
  if (!s) return '';
  if (s.oneOf || s.anyOf) return Array.from(new Set((s.oneOf || s.anyOf)!.map(typeLabel).filter(Boolean))).join(' | ');
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null').join(' | ') : s.type ?? (s.properties ? 'object' : '');
  if (t === 'array') return `${typeLabel(s.items) || 'any'}[]`;
  return s.format ? `${t}<${s.format}>` : t;
}
function inline(text?: string): ReactNode {
  if (!text) return null;
  // minimal Markdown: `code`, **bold**, [link](url); paragraphs split on blank lines
  return text.trim().split(/\n{2,}/).map((para, i) => (
    <p key={i}>
      {para.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((part, j) => {
        if (/^`.*`$/.test(part)) return <code key={j}>{part.slice(1, -1)}</code>;
        if (/^\*\*.*\*\*$/.test(part)) return <strong key={j}>{part.slice(2, -2)}</strong>;
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (m) return <Link key={j} to={m[2]}>{m[1]}</Link>; // Link adds the baseUrl to internal paths
        return part;
      })}
    </p>
  ));
}
function hasChildren(s?: Schema) {
  return !!(s?.properties || s?.items?.properties || s?.oneOf || s?.anyOf);
}
function childSchema(s: Schema): Schema {
  return s.items?.properties ? s.items : s;
}
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ds-api-copy" aria-label={label}
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
      )}
    </button>
  );
}

/* ---------- fields ---------- */
function Field({ name, schema, required, location, depth = 0 }:
  { name: string; schema?: Schema; required?: boolean; location?: string; depth?: number }) {
  const [open, setOpen] = useState(false);
  const s = schema || {};
  const kids = hasChildren(s) ? childSchema(s) : null;
  const variants = s.oneOf || s.anyOf;
  return (
    <div className={clsx('ds-field', depth > 0 && 'ds-field--nested')}>
      <div className="ds-field__head">
        <span className="ds-field__name">{name}</span>
        {typeLabel(s) && <span className="ds-field__type">{typeLabel(s)}</span>}
        {location && <span className="ds-field__type">{location}</span>}
        {required && <span className="ds-field__required">required</span>}
        {s.deprecated && <span className="ds-field__chip ds-field__chip--warn">deprecated</span>}
        {s.readOnly && <span className="ds-field__chip">read-only</span>}
      </div>
      {s.description && <div className="ds-field__desc">{inline(s.description)}</div>}
      <div className="ds-field__meta">
        {s.default !== undefined && <span>Default: <code>{JSON.stringify(s.default)}</code></span>}
        {s.enum && <span>Available options: {s.enum.map((v, i) => <code key={i}>{String(v)}</code>)}</span>}
        {(s.minimum !== undefined || s.maximum !== undefined) &&
          <span>Range: <code>{s.minimum ?? '−∞'} ≤ x ≤ {s.maximum ?? '∞'}</code></span>}
        {(s.minLength !== undefined || s.maxLength !== undefined) &&
          <span>Length: <code>{s.minLength ?? 0}–{s.maxLength ?? '∞'}</code></span>}
        {s.example !== undefined && typeof s.example !== 'object' && <span>Example: <code>{String(s.example)}</code></span>}
      </div>
      {(kids?.properties || variants) && (
        <div className="ds-field__children">
          <button type="button" className="ds-field__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 style={{ transform: open ? 'rotate(45deg)' : 'none' }}><path d="M12 5v14M5 12h14" /></svg>
            {open ? 'Hide' : 'Show'} {variants ? 'options' : 'child attributes'}
          </button>
          {open && (
            <div className="ds-field__child-list">
              {variants
                ? variants.map((v, i) => <Field key={i} name={v.title || `Option ${i + 1}`} schema={v} depth={depth + 1} />)
                : Object.entries(kids!.properties!).map(([k, v]) =>
                    <Field key={k} name={k} schema={v} required={kids!.required?.includes(k)} depth={depth + 1} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="ds-api-section">
      <div className="ds-api-section__head"><h3>{title}</h3>{aside}</div>
      {children}
    </section>
  );
}

function ParamSection({ title, params }: { title: string; params: Param[] }) {
  if (!params.length) return null;
  return (
    <Section title={title}>
      {params.map((p) => (
        <Field key={p.name} name={p.name} required={p.required}
          schema={{ ...(p.schema || {}), description: p.description ?? p.schema?.description, example: p.example ?? p.schema?.example }} />
      ))}
    </Section>
  );
}

function SchemaFields({ schema }: { schema?: Schema | null }) {
  if (!schema) return null;
  const s = schema.items?.properties ? schema.items : schema;
  if (!s.properties) return <Field name={typeLabel(schema) || 'body'} schema={schema} />;
  return <>{Object.entries(s.properties).map(([k, v]) => <Field key={k} name={k} schema={v} required={s.required?.includes(k)} />)}</>;
}

/* ---------- right panel ---------- */
function TabCard({ kind, tabs }:
  { kind: 'request' | 'response'; tabs: { label: string; language: string; code: string; tone?: string }[] }) {
  const [i, setI] = useState(0);
  const t = tabs[i];
  return (
    <div className={clsx('ds-codecard', `ds-codecard--${kind}`)}>
      <div className="ds-codecard__bar">
        {kind === 'request' ? (
          <>
            <span className="ds-codecard__label">{t.label}</span>
            <label className="ds-codecard__select">
              <select value={i} onChange={(e) => setI(Number(e.target.value))} aria-label="Language">
                {tabs.map((x, j) => <option key={x.label} value={j}>{x.label}</option>)}
              </select>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m7 9 5-5 5 5M7 15l5 5 5-5" /></svg>
            </label>
          </>
        ) : (
          <div className="ds-codecard__tabs" role="tablist">
            {tabs.map((x, j) => (
              <button key={x.label} type="button" role="tab" aria-selected={i === j}
                className={clsx('ds-codecard__tab', i === j && 'is-active', x.tone && `tone-${x.tone}`)} onClick={() => setI(j)}>
                {x.label}
              </button>
            ))}
          </div>
        )}
        <CopyButton text={t.code} />
      </div>
      <div className="ds-codecard__body">
        <CodeBlock language={t.language}>{t.code}</CodeBlock>
      </div>
    </div>
  );
}

const isJsonType = (ct?: string | null) => !ct || /json/.test(ct);

function languageFor(ct?: string | null) {
  if (!ct || /json/.test(ct)) return 'json';
  if (/markdown/.test(ct)) return 'markdown';
  if (/html|xml/.test(ct)) return 'markup';
  if (/yaml/.test(ct)) return 'yaml';
  return 'text';
}

/* ---------- page ---------- */
export default function ApiOperation({ op }: { op: Op }) {
  const base = (op.servers[0] || '').replace(/\/$/, '');
  const fullUrl = `${base}${op.path}`;
  const responses = op.responses.map((r) => ({
    label: r.status, language: languageFor(r.contentType),
    code: typeof r.example === 'string' ? r.example
      : r.example !== null && r.example !== undefined ? JSON.stringify(r.example, null, 2) : '{}',
    tone: r.status.startsWith('2') ? 'ok' : r.status.startsWith('4') || r.status.startsWith('5') ? 'err' : undefined,
  }));
  const ok = op.responses.find((r) => r.status.startsWith('2'));
  // The content type whose fields are listed: the first one with a structure (JSON, or an event stream with a schema).
  const structured = ok && (ok.contents?.length ? ok.contents : [{ contentType: ok.contentType, schema: ok.schema }])
    .find((c) => c.schema && (isJsonType(c.contentType) || c.schema.properties || c.schema.items));

  return (
    <div className="ds-api">
      <div className="ds-api__main">
        <h1 className="ds-api__title">{op.summary}</h1>
        <div className="ds-api-endpoint">
          <div className="ds-api-endpoint__field">
            <span className={clsx('ds-api-endpoint__method', `ds-api-endpoint__method--${op.method.toLowerCase()}`)}>{op.method}</span>
            <span className="ds-api-endpoint__path">
              {op.path.split('/').filter(Boolean).map((seg, i) => (
                <React.Fragment key={i}>
                  <span className="ds-api-endpoint__slash">/</span>
                  {/^\{.*\}$/.test(seg) ? <span className="ds-api-endpoint__param">{seg}</span> : <span>{seg}</span>}
                </React.Fragment>
              ))}
            </span>
          </div>
          <CopyButton text={fullUrl} label="Copy URL" />
        </div>
        {op.deprecated && <div className="ds-callout ds-callout--warning" style={{ ['--ds-callout-fg' as string]: '#d97706' }}>This endpoint is deprecated.</div>}
        {op.description && <div className="ds-api__desc">{inline(op.description)}</div>}

        {op.security.length > 0 && (
          <Section title="Authorizations">
            {op.security.map((s) => (
              s.type === 'http' && s.scheme === 'bearer'
                ? <Field key={s.name} name="Authorization" location="header" required={!op.securityOptional}
                    schema={{ type: 'string', description: String((s as any).description || 'Bearer authentication header of the form `Bearer <token>`, where `<token>` is your auth token.') }} />
                : s.type === 'apiKey'
                  ? <Field key={s.name} name={String((s as any).name)} location={String(s.in)} required={!op.securityOptional} schema={{ type: 'string', description: String((s as any).description || 'Your API key.') }} />
                  : <Field key={s.name} name={s.name} schema={{ type: s.type, description: String((s as any).description ?? '') }} />
            ))}
          </Section>
        )}
        <ParamSection title="Path parameters" params={op.params.path} />
        <ParamSection title="Query parameters" params={op.params.query} />
        <ParamSection title="Headers" params={op.params.header} />
        {op.body && (
          <Section title="Body" aside={<span className="ds-api-section__ct">{op.body.contentType}</span>}>
            {op.body.description && <div className="ds-api__desc">{inline(op.body.description)}</div>}
            <SchemaFields schema={op.body.schema} />
          </Section>
        )}
        {ok && (
          <Section title="Response" aside={<span className="ds-api-section__ct">{ok.status}{ok.contentType ? ` · ${(ok.contents?.length ? ok.contents.map((c) => c.contentType) : [ok.contentType]).join(', ')}` : ''}</span>}>
            {ok.description && <div className="ds-api__desc">{inline(ok.description)}</div>}
            {structured && (structured.schema?.description || (ok.contents && ok.contents.length > 1)) && (
              <div className="ds-api__desc">{inline(structured.schema?.description || `Fields of the \`${structured.contentType}\` response:`)}</div>
            )}
            {structured && <SchemaFields schema={structured.schema} />}
          </Section>
        )}
        {ok?.headers && ok.headers.length > 0 && (
          <Section title="Response headers">
            {ok.headers.map((h) => <Field key={h.name} name={h.name} schema={{ ...h.schema, description: h.description || h.schema.description }} />)}
          </Section>
        )}
      </div>

      <aside className="ds-api__aside">
        <div className="ds-api__sticky">
          <TabCard kind="request" tabs={snippets(op)} />
          {responses.length > 0 && <TabCard kind="response" tabs={responses} />}
        </div>
      </aside>
    </div>
  );
}
