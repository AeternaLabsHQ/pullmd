# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/AeternaLabsHQ/pullmd/security/advisories/new)
for this repository. Do not open a public issue for anything that could be
exploited before a fix ships.

You can expect an acknowledgement within 7 days. There is no bug bounty; this
is a volunteer-maintained project. Reporters are credited in the changelog
unless they ask not to be.

## Scope

In scope:

- The SSRF guard (`lib/ssrf.js`) and every fetch path it protects, including
  redirects, sidecars and the MCP tools
- Authentication, sessions and the OAuth 2.1 server
- Share links (`/s/:id`), history scoping and `DISABLE_PUBLIC_HISTORY`
- Input handling on `/api/html` and `/api/file`
- The Docker images and compose files as shipped

Not security issues:

- Extraction quality, sites that block or rate-limit the fetcher
- Anything requiring a compromised host, container or `.env`

## Known and accepted residuals

The SSRF guard resolves a hostname before fetching and re-checks every
redirect hop, but a DNS record that changes between the check and the fetch
(DNS rebinding) is not caught. This was disclosed with the guard in
[PR #42](https://github.com/AeternaLabsHQ/pullmd/pull/42) and is accepted;
operators who need a stricter boundary should run pullmd on an egress-filtered
network. Please do not re-report it.

## Supported versions

Only the latest minor release receives fixes. Upgrade before reporting.
