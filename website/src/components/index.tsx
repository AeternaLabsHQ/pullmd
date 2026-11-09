import React, { type ReactNode } from 'react';
import Link from '@docusaurus/Link';
import clsx from 'clsx';
import Icon from './icons';

/* ---------- Cards ---------- */
export function Card({ title, icon, href, children }: { title: string; icon?: string; href?: string; children?: ReactNode }) {
  const body = (
    <>
      {icon && <span className="ds-card__icon"><Icon name={icon} /></span>}
      <span className="ds-card__title">{title}</span>
      {children && <span className="ds-card__body">{children}</span>}
      {href && <span className="ds-card__arrow"><Icon name="arrow" size={16} /></span>}
    </>
  );
  return href
    ? <Link className="ds-card ds-card--link" to={href}>{body}</Link>
    : <div className="ds-card">{body}</div>;
}

export function CardGroup({ cols = 2, children }: { cols?: 1 | 2 | 3 | 4; children: ReactNode }) {
  return <div className={clsx('ds-card-group', `ds-card-group--${cols}`)}>{children}</div>;
}

/* ---------- Steps ---------- */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="ds-steps">{children}</ol>;
}
export function Step({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <li className="ds-step">
      <div className="ds-step__title">{title}</div>
      <div className="ds-step__body">{children}</div>
    </li>
  );
}

/* ---------- Callouts (Note, Tip, Warning, Info, Check; built-in :::note admonitions also styled) ---------- */
function Callout({ kind, icon, title, children }: { kind: string; icon: string; title?: string; children: ReactNode }) {
  return (
    <div className={clsx('ds-callout', `ds-callout--${kind}`)} role="note">
      <span className="ds-callout__icon"><Icon name={icon} size={18} /></span>
      <div className="ds-callout__content">
        {title && <div className="ds-callout__title">{title}</div>}
        {children}
      </div>
    </div>
  );
}
export const Note = (p: { title?: string; children: ReactNode }) => <Callout kind="note" icon="info" {...p} />;
export const Info = (p: { title?: string; children: ReactNode }) => <Callout kind="info" icon="info" {...p} />;
export const Tip = (p: { title?: string; children: ReactNode }) => <Callout kind="tip" icon="lightbulb" {...p} />;
export const Warning = (p: { title?: string; children: ReactNode }) => <Callout kind="warning" icon="warning" {...p} />;
export const Check = (p: { title?: string; children: ReactNode }) => <Callout kind="check" icon="check" {...p} />;

/* ---------- Accordion ---------- */
export function Accordion({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="ds-accordion" open={defaultOpen}>
      <summary><span className="ds-accordion__chevron"><Icon name="chevron" size={16} /></span>{title}</summary>
      <div className="ds-accordion__body">{children}</div>
    </details>
  );
}
export function AccordionGroup({ children }: { children: ReactNode }) {
  return <div className="ds-accordion-group">{children}</div>;
}

/* ---------- Badges, method labels, frames ---------- */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }) {
  return <span className={clsx('ds-badge', `ds-badge--${tone}`)}>{children}</span>;
}
export function Method({ m }: { m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }) {
  return <span className={clsx('ds-method', `ds-method--${m.toLowerCase()}`)}>{m}</span>;
}
export function Endpoint({ method, path }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string }) {
  return <div className="ds-endpoint"><Method m={method} /><code>{path}</code></div>;
}
export function Frame({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <figure className="ds-frame">
      <div className="ds-frame__inner">{children}</div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/* ---------- Parameter fields (for hand-written reference pages, e.g. config/env vars) ---------- */
export function ParamField({ name, type, required, default: def, children }:
  { name: string; type?: string; required?: boolean; default?: string; children?: ReactNode }) {
  return (
    <div className="ds-param">
      <div className="ds-param__head">
        <code className="ds-param__name">{name}</code>
        {type && <span className="ds-param__type">{type}</span>}
        {required && <span className="ds-param__required">required</span>}
        {def !== undefined && <span className="ds-param__default">default: <code>{def}</code></span>}
      </div>
      {children && <div className="ds-param__body">{children}</div>}
    </div>
  );
}
