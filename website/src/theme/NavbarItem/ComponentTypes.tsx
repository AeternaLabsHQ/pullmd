// Adds a 'custom-search' navbar item (used on mobile and on pages without the docs sidebar).
import ComponentTypes from '@theme-original/NavbarItem/ComponentTypes';
import React from 'react';
import { SearchTrigger } from '@site/src/components/SearchModal';

function NavbarSearch() {
  return <div className="ds-navbar-search"><SearchTrigger compact /></div>;
}

export default { ...ComponentTypes, 'custom-search': NavbarSearch };
