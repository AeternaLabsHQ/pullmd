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
and was an accepted residual until then. Reddit short-link resolution
(`redd.it`, `/s/` share links) used a plain fetch after the check until
3.19.2 and is pinned the same way since.

The Playwright sidecar applies the same address policy to every request
Chromium makes (since 3.15.2, [GHSA-26wr-prg5-vr77](https://github.com/AeternaLabsHQ/pullmd/security/advisories/GHSA-26wr-prg5-vr77)),
but Chromium resolves names itself, so the DNS-rebinding residual remains on
that path and is accepted. For a boundary that does not depend on the
application, the shipped compose files (since 3.20.0) put the sidecar on its
own bridge network, `pullmd-render`, whose only other member is pullmd;
nothing in pullmd needs the sidecar to see the other containers. Operators
with their own compose file should do the same (see `MIGRATION.md`). Please
do not re-report it.

Since 3.20.0 the sidecar's guard covers every page and worker in the render
context, not just the rendered page. Chromium's speculative loading is the
exception: speculation rules delivered by the `Speculation-Rules` response
header, or rules a page script gets past the sidecar's removal of
`<script type="speculationrules">`, can still make Chromium send GET requests
that bypass the guard. These requests are blind: the response reaches neither
the page nor the output. In our tests they reached loopback addresses, while
plain-http targets on the LAN were not reached. The shipped compose files put
the sidecar on its own network that only pullmd joins. Please do not re-report
it.

Since 3.20.0 the boundary for converting documents is the conversion worker
limit, not the input budgets alone. Web pages, HTML uploads and the formats
pullmd reads itself are converted in worker threads (`PULLMD_CONVERT_WORKERS`,
2 by default) with a time limit per conversion (`PULLMD_CONVERT_TIMEOUT_MS`,
60 s of worker time) and a 512 MB heap limit per worker. The markup budgets
measure a document with a tokenizer, without building a tree, and answer
`422 document_too_complex` when it is over; they run before the first parse
and again on the normalised markup. They catch the common cases cheaply; what
they miss is stopped by the limit. This leaves residuals, all accepted:

- An attacker who can send documents can keep the workers busy with slow ones.
  Up to 16 conversions then wait for a worker, at most 30 s each; beyond that
  conversions answer `503 converter_busy` while the rest of the server (cache
  hits, share links, Reddit and Hacker News conversions) keeps answering.
- `PULLMD_CONVERT_WORKERS=0` converts in the server process and removes this
  boundary: a pathological document can then stall or crash the whole server.
  Do not use it on an instance others can reach.
- The heap limit covers each worker's JavaScript heap, not Buffers. Those are
  bounded by the existing size limits for uploads (25 MB, 10 MB for HTML),
  fetched documents (`PULLMD_MAX_FETCH_BYTES`) and the size limit for ZIP
  entries.
- The old.reddit fallback page (`parseOldRedditHtml` in `lib/reddit.js`) is
  parsed without the markup budgets by design, and Hacker News comment HTML
  gets only the raw-input markup budgets. Both are converted on the main
  thread, outside the worker pool, so neither has a time or memory limit
  beyond the size the Reddit and Hacker News APIs return.

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

An upload sent with `async=1` (`POST /api/file`) is converted in the
background, and its result waits in memory under a random 128-bit job id until
the client deletes it or the retention time passes
(`PULLMD_FILE_JOB_TTL_MINUTES`, 60 minutes by default). It is never written to
disk or to the cache, and a restart loses it. With sign-in enabled, a job is
bound to the account that created it, and any other account gets the same
`404` as for an unknown id. Without sign-in, the job id is the only
credential, as with share links: anyone who has the id can read and delete the
result.

## Supported versions

Only the latest minor release receives fixes. Upgrade before reporting.
