# PullMD docs: how to keep them current

This folder is the PullMD documentation site (Docusaurus). `MAINTAINING.md` explains how the site works and which components pages can use. This file says which pages a change touches.

Update the docs in the same pull request as the change. If a change affects what a user can see, send, configure or has to do on upgrade, it affects the docs.

## What to update

| Change | Update |
| --- | --- |
| Any release | `docs/changelog.mdx` (add the release, newest first, move the `Latest` badge). The pinned image version in `docs/self-hosting/installation.mdx` and `docs/self-hosting/upgrading.mdx`. |
| REST parameter, response or status code | `openapi/pullmd.yaml`, the feature's guide, and the status table in `docs/reference/output-format.mdx`. |
| New `X-Source` value | The `X-Source` description in `openapi/pullmd.yaml` and the table in `docs/reference/output-format.mdx`. |
| MCP tool or parameter | `docs/reference/mcp-tools.mdx`. |
| Parameters shown in `/help` or the agent prompt | `docs/agents/prompt.mdx`. |
| Claude Code skill | `docs/agents/claude-code-skill.mdx`. |
| Environment variable | `docs/reference/configuration.mdx`. Mark it † if the compose files don't pass it through, and keep the Warning at the top of that page in step. |
| Compose files gain or lose a variable | The "as of v…" notes in `configuration.mdx`, `installation.mdx`, `authentication.mdx`, `ssrf-protection.mdx` and `troubleshooting.mdx`. |
| Upload or document format | `docs/guides/documents.mdx`, `/api/file` in `openapi/pullmd.yaml`. |
| Reddit or Hacker News behavior | `docs/guides/reddit-and-hacker-news.mdx`. |
| SSRF or sign-in behavior | `docs/self-hosting/ssrf-protection.mdx` or `docs/self-hosting/authentication.mdx`. |
| `/api/status` | `docs/self-hosting/monitoring.mdx`, `/api/status` in `openapi/pullmd.yaml`. |
| Anything that needs action on upgrade | A new section in `docs/self-hosting/upgrading.mdx`, and a `warning` badge on the changelog entry. |
| New error message | The feature's guide and `docs/troubleshooting.mdx`, quoted exactly. |
| New page | Add it to `sidebars.ts` unless its section is auto-generated, with a `title` and `description`. |

## What updates itself

Don't edit these by hand:

- `docs/reference/api/` and `src/generated/`, generated from `openapi/pullmd.yaml`.
- `/llms.txt`, the `.md` copy of each page and `/openapi.yaml`, generated at build.

## Writing rules

- Address the reader as "you", or use the imperative. Present tense, active voice, short sentences.
- Feature pages describe current behavior as fact. "No longer", "now" and "new" belong in the changelog.
- Every claim comes from the code or a test. Copy numbers, defaults and limits from the source.
- Capture example output and error messages from a running instance. Don't write them by hand.
- Use the product's own names: its interface labels, parameters and config keys.
- No marketing words, no time estimates, no em dashes.
- Changelog entries say what a reader can see or act on. Leave out internal changes, and never rewrite a past entry.

## Before finishing

Run these from this folder:

```bash
npm ci
npm run build
```

The build fails on a broken internal link or anchor. After removing an API endpoint, run `npm run clean-api` first. To check pages visually, run `npm start -- --port 3001` and open http://localhost:3001/pullmd/.

Try new or changed behavior against a running instance before documenting it.
