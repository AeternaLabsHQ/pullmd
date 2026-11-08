// Replace the stock sun/moon toggle everywhere (mobile drawer, pages without the docs sidebar).
import React from 'react';
import ThemeSwitch from '@site/src/components/ThemeSwitch';

export default function ColorModeToggle({ className }: { className?: string }) {
  return <div className={className}><ThemeSwitch /></div>;
}
