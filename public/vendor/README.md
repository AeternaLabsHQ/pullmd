# Vendor (frontend)

Self-hosted third-party libraries used by the PullMD PWA. Self-hosted (not CDN) so the Service Worker can precache them for offline use.

## marked

- **File:** `marked.min.js`
- **Version:** 12.0.2
- **License:** MIT — Copyright (c) 2011-2024 Christopher Jeffrey
- **Project:** https://github.com/markedjs/marked
- **Source:** https://cdn.jsdelivr.net/npm/marked@12/marked.min.js

## DOMPurify

- **File:** `purify.min.js`
- **Version:** 3.4.2
- **License:** Apache-2.0 OR MPL-2.0 — Copyright (c) Cure53 and other contributors
- **Project:** https://github.com/cure53/DOMPurify
- **Source:** https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js

## Refreshing

```bash
cd public/vendor
curl -fsSL -o marked.min.js https://cdn.jsdelivr.net/npm/marked@12/marked.min.js
curl -fsSL -o purify.min.js https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js
```

Bump `CACHE_NAME` in `public/sw.js` after replacing vendor files so PWAs re-precache.
