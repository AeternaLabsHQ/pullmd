# Maintaining these docs

The docs live in `website/`, as plain Markdown files. Edit a file, open a pull request and merge: the site rebuilds and publishes itself through GitHub Actions to GitHub Pages. Run the commands below from `website/`.

## On each release

Update the pages a release changes, in the same pull request:

- `docs/changelog.mdx`: add the release, newest first, and move the `Latest` badge.
- `openapi/pullmd.yaml`: new or changed parameters, responses and `X-Source` values.
- `docs/reference/configuration.mdx`: new environment variables. Mark with † any variable the compose files don't pass through.
- `docs/self-hosting/upgrading.mdx`: anything that needs action on upgrade.
- The guide for the feature, and the pinned version in `docs/self-hosting/installation.mdx` and `upgrading.mdx`.

Describe current behavior on feature pages. "No longer" and "now" belong in the changelog.

## Common tasks

| Task | How |
|---|---|
| Edit a page | Edit the `.mdx` file in `docs/`, or click "Suggest edits" at the bottom of the page on the live site. |
| Add a page | Add a `.mdx` file in `docs/` (or `docs/guides/`). Give it a `title` and `description` in the frontmatter. Add it to `sidebars.ts` if it isn't in an auto-generated section. |
| Update the API reference | Edit the spec in `openapi/`. `npm start` and `npm run build` regenerate the pages from it; after removing an endpoint, run `npm run clean-api` first. Never hand-edit files in `docs/reference/api/`; they're regenerated. |
| Preview locally | `npm ci`, then `npm start -- --port 3001` (PullMD itself usually has port 3000) and open http://localhost:3001/pullmd/. |
| Check before merging | `npm run build` fails on broken internal links, so a green build means no broken links. |

## Components you can use in any page (no import needed)

`<Card>`, `<CardGroup cols={2}>`, `<Steps>` + `<Step title="">`, `<Note>`, `<Tip>`, `<Warning>`, `<Info>`, `<Check>`, `<Accordion>`, `<AccordionGroup>`, `<Badge>`, `<Endpoint method="GET" path="/x">`, `<ParamField name="" type="" default="">`, `<Frame caption="">`, `<Tabs>` + `<TabItem>`.

Card icons: rocket, book, code, terminal, plug, gear, bolt, shield, search, info, lightbulb, warning, check.

## Settings

Product name, URLs, colours and logo live in `site.config.ts`. Colours for light and dark mode are the first lines of `src/css/theme.css`.

## Custom domain

Add a CNAME DNS record pointing to `<org>.github.io` and set the domain under the repo's Settings → Pages. The deploy workflow builds for whatever address Pages serves the site at, so nothing in the code has to change. Update `url` and `baseUrl` in `site.config.ts` too, so local builds match.

## AI-readable output

Every build publishes `/llms.txt` (every sidebar page with its description, grouped under the sidebar headings), a `.md` copy of each page (API reference pages carry their slice of the spec as YAML), and the OpenAPI spec at `/openapi.yaml`. Nothing to maintain: a page added to a sidebar shows up in both, and its `description` frontmatter becomes the llms.txt summary.
