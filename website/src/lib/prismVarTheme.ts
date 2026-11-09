// Code highlighting colours as CSS variables.
// Docusaurus renders code blocks on the server with the light theme's inline colours and
// swaps to the dark theme after hydration, so dark-mode visitors see light-theme colours
// (pink strings) flash on reload. Here both modes share one theme whose colours are
// var(--ds-tok-*), and the actual values switch with [data-theme] in a <style> tag.
import type { PrismTheme } from 'prism-react-renderer';

type Props = { color?: string; fontStyle?: string; fontWeight?: string; textDecorationLine?: string; opacity?: number };

function resolve(theme: PrismTheme) {
  const map = new Map<string, Props>();
  for (const s of theme.styles) {
    for (const t of s.types) {
      const key = s.languages ? `${s.languages.join('-')}--${t}` : t;
      map.set(key, { ...(map.get(key) ?? {}), ...(s.style as Props) });
    }
  }
  return map;
}

const slug = (k: string) => k.replace(/[^a-zA-Z0-9-]/g, '-');

export function prismVarTheme(light: PrismTheme, dark: PrismTheme): { theme: PrismTheme; css: string } {
  const L = resolve(light), D = resolve(dark);
  const keys = Array.from(new Set([...Array.from(L.keys()), ...Array.from(D.keys())]));
  const decl = (map: Map<string, Props>, plain: PrismTheme['plain']) => keys.map((k) => {
    const p = map.get(k) ?? {};
    const n = slug(k);
    return `--ds-tok-${n}:${p.color ?? plain.color};--ds-tok-${n}-fs:${p.fontStyle ?? 'normal'};--ds-tok-${n}-fw:${p.fontWeight ?? 'inherit'};--ds-tok-${n}-op:${p.opacity ?? 1};`;
  }).join('');
  const css = `:root{--ds-tok-plain:${light.plain.color};${decl(L, light.plain)}}`
    + `[data-theme='dark']{--ds-tok-plain:${dark.plain.color};${decl(D, dark.plain)}}`;
  const styles = keys.map((k) => {
    const [langs, type] = k.includes('--') ? k.split('--') : [null, k];
    const n = slug(k);
    return {
      types: [type],
      ...(langs ? { languages: langs.split('-') as never } : {}),
      style: { color: `var(--ds-tok-${n})`, fontStyle: `var(--ds-tok-${n}-fs)` as never, fontWeight: `var(--ds-tok-${n}-fw)` as never, opacity: `var(--ds-tok-${n}-op)` as never },
    };
  });
  return { theme: { plain: { color: 'var(--ds-tok-plain)', backgroundColor: 'transparent' }, styles }, css };
}
