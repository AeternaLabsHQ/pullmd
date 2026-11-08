// Every logo slot (desktop sidebar, mobile navbar) renders the site brand.
import React from 'react';
import Brand from '@site/src/components/Brand';

export default function Logo({ className }: { className?: string }) {
  return <Brand className={className} />;
}
