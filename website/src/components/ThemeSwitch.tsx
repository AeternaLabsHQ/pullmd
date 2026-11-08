// Three-way theme switch: system / light / dark.
import React from 'react';
import clsx from 'clsx';
import { useColorMode } from '@docusaurus/theme-common';

const options = [
  { value: null, label: 'System', path: <path d="M4 5h16v11H4zM8 20h8M12 16v4" /> },
  { value: 'light', label: 'Light', path: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  { value: 'dark', label: 'Dark', path: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /> },
] as const;

export default function ThemeSwitch() {
  const { colorModeChoice, setColorMode } = useColorMode();
  return (
    <div className="ds-theme-switch" role="radiogroup" aria-label="Color theme">
      {options.map((o) => (
        <button key={o.label} type="button" role="radio" aria-checked={colorModeChoice === o.value} title={o.label}
          className={clsx('ds-theme-switch__btn', colorModeChoice === o.value && 'is-active')}
          onClick={() => setColorMode(o.value)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{o.path}</svg>
        </button>
      ))}
    </div>
  );
}
