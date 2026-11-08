# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/AeternaLabsHQ/pullmd/security/advisories/new)
for this repository. Do not open a public issue for anything that could be
exploited before a fix ships.

You can expect an acknowledgement within 7 days. There is no bug bounty; this
is a volunteer-maintained project. Reporters are credited in the changelog
unless they ask not to be.

### What a report needs

pullmd runs with one `docker compose up`. A report has to show the problem on
a running instance of the current release:

- the version tested (`GET /api/status` or the image tag)
- the exact request(s) sent to pullmd and the response(s) received
- for SSRF claims, what the internal stand-in service logged

A reproduction against a re-implementation of the code, a static reading of a
single file, or a proof of concept that was never run against pullmd itself
does not meet this bar. Reports written by or with automated tooling are fine
as long as the finding was verified on a real instance by a person who read
this policy; reports that evidently were not are closed without reply, as are
re-reports of the residuals listed below. No CVE is assigned for accepted
residuals or for behaviour this document describes as intended.

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

The static fetch path (`lib/ssrf.js`) resolves a hostname, checks every
answer against the address policy and, since 3.18.2, opens the socket to
exactly the address it checked; a name that rebinds between check and
connect (DNS rebinding) is no longer followed there. This gap was disclosed
with the guard in [PR #42](https://github.com/AeternaLabsHQ/pullmd/pull/42)
and was an accepted residual until then.

The Playwright sidecar applies the same address policy to every request
Chromium makes (since 3.15.2, [GHSA-26wr-prg5-vr77](https://github.com/AeternaLabsHQ/pullmd/security/advisories/GHSA-26wr-prg5-vr77)),
but Chromium resolves names itself, so the DNS-rebinding residual remains on
that path and is accepted. Operators who want a boundary that does not depend
on the application can put the sidecar on its own bridge network with no
other service on it; nothing in pullmd needs the sidecar to see the other
containers. Please do not re-report it.

Text transcribed from Reddit post images (`PULLMD_EMBEDDED_IMAGES`, since 3.16.0)
is untrusted third-party content and can carry prompt injection. The output
labels it as machine-derived from the image; consumers should treat it like any
other fetched page text. This is inherent to describing arbitrary images and
not a vulnerability in pullmd.

Without sign-in (`PULLMD_AUTH_MODE` unset or `disabled`) and with public
history on (the default), every client that can reach the port can list
recent conversions including their share ids, and can delete cache entries.
This is the documented open mode, not a vulnerability. Operators who share an
instance should enable sign-in or set `DISABLE_PUBLIC_HISTORY=true`, which
also refuses anonymous deletes, or keep the port off public networks.

## Supported versions

Only the latest minor release receives fixes. Upgrade before reporting.
