# PullMD docs

The source of the PullMD documentation site, built with [Docusaurus](https://docusaurus.io) and published to GitHub Pages. Run the commands below from this folder.

- Pages are Markdown (`.mdx`) files in `docs/`. The sidebar order is in `sidebars.ts`.
- The API reference is generated from the OpenAPI spec in `openapi/pullmd.yaml`.
- Every build also publishes `/llms.txt`, a Markdown copy of each page and the spec at `/openapi.yaml`, for AI tools.

```bash
npm ci
npm start -- --port 3001   # http://localhost:3001/pullmd/
npm run build              # fails on broken links
```

How to edit pages, update the API reference and use the page components: see [MAINTAINING.md](MAINTAINING.md).
