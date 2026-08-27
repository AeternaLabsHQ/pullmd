# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Self-hosters should consult [`MIGRATION.md`](./MIGRATION.md) when upgrading across a major version.

---

## [Unreleased]

<!-- Renamed to the dated version heading when the release is cut. Every other
     version heading resolves through the reference-link list at the end of
     this file - add the matching `[X.Y.Z]: .../releases/tag/vX.Y.Z` line
     there at the same time, or this heading renders as literal bracketed
     text. -->

---

## [3.10.0] - 2026-08-27

### Added

- **`GET /api/status` reports sidecar health for external monitoring.** It probes the `/health` endpoint of every configured extraction sidecar (trafilatura, Playwright, markitdown) in parallel and answers `200` when they all respond, `503` as soon as one is down, so a plain HTTP check catches it without keyword matching. A sidecar that was never configured counts as `not-configured`, not as a failure. Error reasons are a closed vocabulary (`unreachable`, `timeout`, `unhealthy`, `http <code>`, `misconfigured`) because the endpoint is public and must not echo internal hostnames. Results are cached for 5 seconds and concurrent callers share one round of probes. A broken sidecar does not take the service down, it silently degrades extraction quality — this makes that state observable.

- **Site-recipes can now read structured data from embedded JSON state blocks.** Single-page frameworks render state as SSR blobs in `<script>` elements for the initial HTML. The new optional recipe field `append` extracts this data (by script selector and segment path, with optional field projection and row limit), serializes it as JSON, and appends it to the end of the document as a fenced code block. Output size is capped. The feature exists for pages where numerical data is only rendered as a chart and is therefore unreachable by CSS selectors.

### Fixed

- **`playwright-stealth` is now version-pinned** in `playwright-sidecar/requirements.txt`, like every other sidecar dependency. It was the only unpinned one, so any rebuild could have pulled an incompatible release into the image unnoticed.

---

## [3.9.0] - 2026-08-01

### Added

- **Download button in the PWA.** A third action in the result toolbar, beside Copy and Share: it writes the Markdown as currently shown (the frontmatter toggle is respected) to a file and saves it under the name the server suggests. Unlike Share it needs no browser capability check, so it is visible whenever a result is. Three buttons no longer fit a phone header, so the existing 480px breakpoint now collapses all three to icon-only; their accessible names survive as `title` / `aria-label` through the existing translation mechanism, so they stay readable to a screen reader and stay translated.
- **The server now suggests the download filename** (`X-Suggested-Filename`). The name used to be derived in the browser from the frontmatter title alone, which gave a YouTube video its cryptic id as a name and threw away the original basename of an uploaded image or document. The server knows the extraction source, the URL and the title, so it builds the suggestion instead: YouTube becomes `YT-<title>-<video-id>`, the file-based sources (`image-caption`, `audio-transcript`, `markitdown`, `pdf-ocr`) keep the basename of the source file, and everything else uses the title slug, with a title → URL basename → share id → `pullmd` fallback chain and a final pass that leaves only characters an HTTP header and a filesystem both accept. The header is set on `GET /api` (fresh and cached), `POST /api/html`, `POST /api/file` and `GET /s/:id`; `GET /api/stream` carries the same value as a `suggestedFilename` field on the `result` event, because SSE headers are flushed long before the result exists and the SSE path is what the PWA uses. The new `PULLMD_FILENAME_DATE_PREFIX` prepends a rendered date to every name (tokens `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, local time, every other character passes through); it is unset by default, so nothing changes unless you ask for it. The PWA prefers the server suggestion and keeps its own client-side chain as a fallback against an older server.

### Changed

- **`query` is now described by when to use it, not by how it works.** The MCP `read_url` schema, the bundled Claude Code skill, the README and the in-app help page all described the parameter mechanically ("return only the sections relevant to this text", "BM25 over the converted Markdown"), which told an agent what the feature does but never that it should reach for it. In practice the parameter went unused: a model reading the old description had no trigger condition to match against. All four surfaces now lead with the trigger - when you need specific information from a page rather than the whole document, pass the question you are trying to answer, in natural language - name the payoff (typically 70-95% fewer tokens on long pages), and frame the full-page fetch as the case that needs a reason (summarizing, translating, archiving). `max_tokens` additionally states that it has no effect without `query`. Text only: no parameter, default, validation or response shape changed, and nothing changes for an existing integration except how likely an agent is to use the parameter at all.
- **`read_url`'s description now opens with a precedence rule.** It states up front that this is the preferred way to read any URL and should be used instead of the built-in web fetch tool, not just when that one fails. Previously the description led with a capability list (SPAs, Reddit, Cloudflare, documents), which read as "fallback for hard pages" and left an agent with a native fetch tool no reason to prefer PullMD for ordinary URLs. The capability list and the rest of the text are unchanged; only the order changed. Nothing changes for existing integrations except the likelihood the tool gets chosen.
- **`PULLMD_LLM_MODEL` now says out loud that it is not a variable.** The shared `PULLMD_LLM_*` fallback covers the API key and the base URL but not the model, because one name cannot be a vision chat model, a speech model and an OCR model at once. That asymmetry was invisible: setting `PULLMD_LLM_MODEL` looked exactly as reasonable as the two variables next to it, was read by nobody, and left every modality on its own default with no hint as to why. The server now warns at startup when it is set and names the three variables that do work (`PULLMD_VISION_MODEL`, `PULLMD_STT_MODEL`, `PULLMD_PDF_OCR_MODEL`); the README and `.env.example` state the limit where the fallback is introduced instead of leaving it to be inferred.

### Fixed

- **The rendered view no longer turns the frontmatter into a giant heading.** `marked` reads `key: value` followed by `---` as a setext heading, so with the frontmatter toggle on, the rendered view opened with a title made of metadata. Only the body goes through `marked` now; the frontmatter is prepended as a plain, quieter code box, filled via `textContent` so a user-controlled title or URL is never parsed as markup.
- **The result toolbar's actions stay right-aligned when the row wraps.** `space-between` left-aligns a lone wrapped flex item, so on a narrow screen Copy/Share/Download dropped to a second line and sat on the left; they are now pinned to the right edge on every line.
- **Image captioning worked against no current OpenAI model.** The request sent `max_tokens`, which those models reject outright ("Unsupported parameter ... use `max_completion_tokens` instead"), so every caption failed with a 400 and the conversion degraded quietly to plain extraction: pointing `PULLMD_VISION_MODEL` at anything recent produced no captions at all. Switching unconditionally was not an option either, because many OpenAI-compatible endpoints only understand `max_tokens`. The request therefore still asks the way everything understands and retries once with `max_completion_tokens` when the endpoint says that is what it wants. Deciding from the model name was rejected on purpose: any such list is stale by the next model release.
- **Reasoning models returned an empty caption.** `max_tokens` caps visible output, `max_completion_tokens` caps visible output plus the reasoning tokens a reasoning model never shows, so reusing the same 500 meant the model spent its whole budget thinking and returned an empty message. Measured against a current small reasoning model, 500 and 1000 both came back `finish_reason=length` with zero characters of text, while the first usable caption needed around 1600 completion tokens, 1472 of them reasoning. The retry path now asks for 4000, which costs nothing when unused because only generated tokens are billed. An empty caption is no longer handed back either: it used to yield a `## Description` heading with nothing under it, still labelled as the image-caption source, where a throw is caught, logged, and falls back to markitdown.
- **The admin CLI silently did nothing when stdin was already at EOF.** `docker exec` without `-i` hands the process exactly that, and `readline`'s `question()` never settles on it, so `create-user` and `reset-password` printed "New password:" and exited 0 having created or changed nothing - the most natural way to invoke the CLI against a running container was also the one silent failure mode it had. The non-interactive branch now reads the stream directly instead of going through `readline`, which fixes a second case in passing: a piped password without a trailing newline used to be dropped the same silent way, because `readline` does not hand over a final line that never terminates. CRLF is stripped. An empty stdin raises an operator-facing error naming three working invocations and exits 2 without a stack trace. The interactive TTY path is untouched.

### Documentation

- **The help page documents user management.** The admin CLI existed only in the README and the changelog, so an operator looking at their own instance had no way of finding out that accounts are created with `scripts/admin.js`. The authentication section now lists `list-users`, `create-user`, `make-admin` and `reset-password`, states that there is no UI for any of it, and names the invocations that actually deliver a password on stdin.
- **README, help page and skill bundle audited against this batch.** `X-Suggested-Filename` was missing from the README's response-header list and from the skill's "headers worth checking"; the download button was missing from the README's feature list; the README documented `create-user` / `reset-password` without a word on the stdin requirement. The universal agent prompt, which ships in both the README and the help page, opened with "instead of raw HTML" - a phrasing an agent holding a native browse tool does not match on, which is the same failure the `read_url` description fixed; both copies now name the built-in fetch tool and reject the fallback-only reading.

---

## [3.8.0] - 2026-07-31

### Added

- **`PULLMD_ALLOW_SIGNUP` closes self-registration in `multi-user` mode.** Default is on, so an existing instance behaves exactly as before; only `false`, `0`, `no` or `off` turns it off. When off, the `/signup` routes are not mounted at all, so both GET and POST answer 404 and no account can be created by a crafted request, the login page drops its "create an account" link, and `/api/config` reports `signupOpen: false`. This is for running a public demo instance in `multi-user` mode without collecting stranger accounts. `createAuth` exposes the raw switch as `allowSignup` and the effective value as `signupOpen` (`mode === 'multi-user' && allowSignup`); only the effective value is read anywhere in production code, because a switch that is on while the mode has no signup route at all is not useful information.
- **`node scripts/admin.js create-user <email>`** with a password prompt, so "registration closed" is not a state an operator cannot get out of. The account is created without admin rights; `make-admin` promotes it as a separate step.

### Changed

- **Cache deletes are now scoped to the caller instead of being rejected** (closes #49). `DELETE /api/cache/:id` and `DELETE /api/cache` used to sit behind an admin-only guard, so a logged-in non-admin got `403 {"error":"Admin required"}` and could never clear anything from their own history, even though the frontend offered them the button. The guard's premise was sound only halfway: `conversions` is deduplicated by URL and therefore shared between all users, so dropping a row does affect everyone - but each user's history is a separate `user_fetches` join table, and unlinking a row there affects nobody else. An admin (and every caller when `PULLMD_AUTH_MODE` is `disabled` or unset) still purges the shared row; a regular user now only unlinks their own history entry, leaving the shared row and its `/s/:id` share link intact. Both responses gained `scope: "user" | "global"`, and delete-all gained `removed`. Existing status codes are unchanged. **For API consumers:** in `single-admin` and `multi-user` modes a non-admin `DELETE /api/cache*` now answers `200` with `scope: "user"` where it previously answered `403`.
- **The delete button says which of the two it does.** The same `×` now means "remove from my history" or "delete globally" depending on the caller, so the tooltip and the archive's delete-all confirmation name the scope. When the caller's role cannot be determined the label errs toward "global", because claiming a global delete for one that turns out to be scoped costs nothing, while the reverse puts a harmless label on a destructive action.

### Fixed

- **Orphaned history rows inflated the archive's entry count.** `user_fetches.cache_id` has no foreign key to `conversions`, and `pruneOld` - which runs on every conversion and drops entries older than 90 days - never removed the matching history rows. Since `countForUser` counts without the join that `historyPageForUser` uses, the archive reported more entries than it could ever return and paginated toward entries that never arrived, drifting further with every prune. Cleanup is now explicit in the delete paths and after a prune that actually removed something, plus a one-time sweep when the cache opens, so an existing database repairs itself on the next start. A real foreign key with `ON DELETE CASCADE` was deliberately not introduced: better-sqlite3 only enforces foreign keys with `PRAGMA foreign_keys=ON`, and enabling that globally would start enforcing constraints across the OAuth and session tables too.
- **A failed delete is now visible.** Both entry-delete handlers turned a failed request into a red border and a `title` attribute and never called the page's own error banner, so a rejected delete looked like a dead button; the archive's delete-all had no failure path at all. All three now surface the failure. This also required fixing the banner itself: opening the archive view hides the shared error element with an inline style that outranks the class the banner is shown with, so a message raised from inside the archive would not have rendered.
- **`reset-password` and `create-user` silently did nothing when the password came from a pipe.** `scripts/admin.js` reads passwords through `node:readline/promises`, whose `question()` returns a promise and ignores a callback, but the non-interactive branch passed one. The promise never settled, the process exited 0, and nothing was written - so a scripted `reset-password` reported success without changing anything, for as long as that command has existed. Interactive use was never affected. A test that drives the real CLI as a child process with piped stdin now guards it.
- **Read-only admin CLI commands no longer write to the database.** `list-users`, `reset-password` and `make-admin` ran the auth migration on startup. Because the CLI defaults to `multi-user` while the server defaults to `disabled`, on an auth-disabled instance `list-users` either aborted with a stack trace or silently bootstrapped an admin user from whatever credentials were in the environment, claimed every existing conversion for it and backfilled history rows.
- **The login page no longer links to a page that does not exist.** The "create an account" link was rendered in every auth mode, but `/signup` only exists in `multi-user`, so in `single-admin` the link led to a 404. It is now tied to whether the route is actually reachable.

---

## [3.7.1] - 2026-07-31

### Documentation

- **The in-app help page now documents the service as it ships** (#48). It had drifted to a v3.0 view: the extraction stack was described as "Readability + Turndown" (a dependency replaced by `node-html-markdown`, with Trafilatura and the headless-Chromium stage missing from the list entirely), and `comments` / `comment_depth` were still presented as Reddit-only although Hacker News has honored them since 3.1. New sections cover the endpoints (all 13, including `/api/stream`, archive, storage, stats, config and recipes status), the response headers (including `X-Transcript-Status` and the five `X-Extract-*` headers), query extraction, site recipes, and authentication. That last gap was the practical one: `/help` stays public when `PULLMD_AUTH_MODE` is set, but it never mentioned login, API keys or OAuth, so an instance could reject every API call without telling anyone how to authenticate. "Local HTML files" grew into a "converting files" section covering `/api/html`, `/api/file`, document URLs and images/audio/YouTube; the parameter table gained `render`, `extractor`, `pdf`, `yt_timecodes`, `yt_chunk` and `max_tokens`; and the drop-in agent prompt was synced with the README version plus `query`.
- **README: SSRF protection documented.** The guard shipped in 3.3.0, but the README never mentioned it, so the default-deny behavior and the `PULLMD_ALLOWED_HOSTS` opt-out were only discoverable from the changelog or `.env.example`. Also adds `PULLMD_ALLOWED_HOSTS` and `PULLMD_SITE_RECIPES` to the configuration table, `/api/config` and `/api/recipes/status` to the endpoint table, `query` / `max_tokens` / `pdf=ocr` to the universal prompt, and a summary of what the 3.x line added after 3.0.
- **Bundled Claude Code skill:** Hacker News (pipeline entry and `X-Source` value), `query` / `max_tokens` with an example and a usage tip, `X-Transcript-Status`, and the `X-Extract-*` headers.

---

## [3.7.0] - 2026-07-31

### Added

- **Coverage guard — extractions that keep only a sliver of the page now recover the rest** (closes #46). Readability commits to a single best candidate container. On the one-pagers page builders emit, the article is a flat list of sibling blocks whose prose sits several levels deep; Readability's candidate score dilutes with nesting depth, so a shallow paragraph-rich block near the top outscores the far larger content below it, and everything else is dropped. The output is well-formed markdown, so nothing downstream signals the loss — measured on one such page, 10,503 of 336,670 characters, 3.1% coverage. The guard now re-converts the container that holds the body instead, which is an auto-written `select.content` through the same conversion path a recipe takes. It fires only when all of the following hold: no recipe `select.content`, no forced static extractor, a cleaned body of at least 20,000 characters, coverage under 10%, a single container dominating the body text, and a recovered candidate at least 3× larger with at least 5 paragraphs. The dominance condition is what separates one article split across siblings from many separate teasers, and it is what keeps listing pages out. Calibrated against an 85-page live corpus (forum threads, comment-heavy blogs, wikis, long single-document pages, shops, listing homepages, landing pages): it fires on 1 of 85 and on 0 of 12 forum threads, with roughly a factor of 2 between the shipped thresholds and the first false positive. The guard can only grow a result, degrades to previous behavior on any error, and is switched off with the new `PULLMD_COVERAGE_GUARD=off`. Every intervention carries `source: coverage-guard` and records what it acted on in `metadata.extractorReason` — coverage, body size, gain, and the share of the body the recovered container actually holds. A `select.content` recipe still wins outright, so a site that needs finer cleanup can keep one.

---

## [3.6.0] - 2026-07-26

### Added

- **`select.content` — recipes can now name the article body outright.** Until now the recipe engine was purely subtractive (`select.remove`, `preprocess`): a recipe could say what to throw away, but never what the article *is*, leaving the final choice to Readability's candidate scoring. `select.content` takes a list of CSS selectors, joins every match in document order into a single document, and uses that as the body — skipping both the Readability scoring and the Trafilatura auto-pick. Nested matches collapse to the outermost, invalid selectors skip themselves, and `select.remove` still applies first, so the two compose. Output carries `source: recipe-content`. Because a stale `content` selector would otherwise yield an empty article, a selection under 200 characters falls back to the normal pipeline and records the reason in `metadata.extractorReason`. Documented in [`SITE-RECIPES.md`](./SITE-RECIPES.md).

### Fixed

- **Blog posts whose body is split across sibling containers lost everything outside the winning block** (closes #44). Some CMS templates wedge an in-article call-to-action between two separate body containers; Readability scores a single top candidate and keeps only that candidate plus its direct siblings, so the entire lead section was dropped while the output still looked well-formed. A shipped recipe (`claude-blog-split-body`) now names both containers via the new `select.content`. The Trafilatura auto-pick could not catch this on its own: its output carried the full text but no markdown headings, and `pickBest` requires at least one heading before preferring the longer candidate.

---

## [3.5.0] - 2026-07-10

### Added

- **Recipe-defined frontmatter fields.** Site recipes can now inject custom frontmatter fields via a new `frontmatter` block, sourced from a page's embedded JSON-LD (`<script type="application/ld+json">`, selected by schema.org `@type` and resolved with a dot-path) or from CSS selectors. Field names are validated (letter-led, ≤ 64 chars); pipeline-computed names (provenance, share/cache bookkeeping, media/LLM-usage) are reserved and reject the recipe, while metadata-derived names (`title`, `author`, `published`, `modified`, `description`, `language`, `image`, `site`) are overridable and beat the generic scrape on a collision. When `PULLMD_FRONTMATTER_FIELDS` is set as an allowlist, recipe fields it drops are surfaced in the startup log and in the new `filteredFrontmatterFields` array of `GET /api/recipes/status`.
- **Booking.com hotel-listing recipes** (`booking-hotel-noise`, `booking-hotel-frontmatter`, closes #40). Hotel pages (`/hotel/**`) are rendered via Playwright (the raw response is an AWS-WAF challenge shell), page chrome is stripped (header/footer/searchbox, gallery, breadcrumbs, Genius/promo banners, review-avatar flags, payment-card images, lazy-loading Q&A skeleton), and the Hotel JSON-LD is mapped into frontmatter (`description`, `address`, `rating`, `rating_best`, `review_count`, `price_range`). The body keeps the hotel description, popular facilities, room table (with prices when the URL carries `checkin`/`checkout` dates), house rules and fine print.
- **Site-recipe contributor guide** ([`SITE-RECIPES.md`](./SITE-RECIPES.md)), documenting the recipe engine end to end — matching and merge semantics, the full schema, rendered-DOM handling, JSON-LD-to-frontmatter, and the testing/PR workflow — with a pointer added from the README.

### Fixed

- Recipe `select.remove` now also applies to the HTML sent to the Trafilatura sidecar — previously it was a silent no-op whenever the quality auto-pick chose Trafilatura, so recipe-removed elements still leaked into the output. Selectors are now applied one by one, so an invalid selector is skipped individually instead of risking whole-page extraction failure.

---

## [3.4.0] - 2026-07-10

### Added

- **Query-scoped extraction** (`?query=`). `GET /api` and the MCP `read_url` tool accept an optional `query` param that returns only the sections of the page relevant to that text - a BM25 ranking over heading-based sections of the converted markdown (paragraph-level fallback for pages with fewer than two headings), with no network calls and no LLM involved. Budget via `max_tokens` (default `600`, range `64`-`20000`). Falls back to the whole page (`confidence: low`) when nothing in the page scores against the query, or when the page is already small enough that extraction wouldn't help. New response headers (`X-Extracted`, `X-Extract-Confidence`, `X-Extract-Sections`, `X-Extract-Original-Tokens`, `X-Extract-Returned-Tokens`), a `format=json` `extract` object, and `?frontmatter=true` fields (`extracted`, `extract_confidence`, `sections_selected`, `original_tokens`, `returned_tokens`) expose the result. Extraction runs on the already-cached full page, so multiple `query` values against one URL cost a single fetch within the normal cache TTL. Omitting `query` (or passing an empty/whitespace-only value) leaves `/api` output byte-identical to pre-3.4 behavior.

---

## [3.3.0] - 2026-07-08

### Security

- **Block Server-Side Request Forgery (SSRF)** (closes #41). The URL-fetch endpoints (`GET /api`, the MCP `read_url` tool, and the Reddit/web/Playwright fetch paths behind them) now resolve the target host and reject any resolved address in the private, loopback, link-local, CGNAT or cloud-metadata ranges - including `169.254.169.254` and `100.100.100.200`, the addresses used by the reported exploit. Each redirect hop is re-checked before it is followed, and the Playwright sidecar path is validated Node-side before dispatch. Requests to a blocked host return HTTP 403.
- Self-hosters who intentionally need an internal host (e.g. an intranet wiki) can allowlist specific CIDRs and/or exact hostnames via the new `PULLMD_ALLOWED_HOSTS` env var (comma-separated, empty by default = block all internal targets). See `.env.example`.
- **Known residual:** the guard checks resolved IPs at request time but does not pin the outbound socket to the checked address, so a DNS-rebinding attack (where the name resolves differently between the check and the actual connection) is not fully closed by this fix. When running behind an outbound HTTP proxy, the proxy performs its own name resolution, so its egress filtering - not this guard - is the authoritative layer for traffic it forwards.

---

## [3.2.0] - 2026-06-25

### Added

- **`X-Transcript-Status` response header** (#37, closes #36). YouTube conversions now expose the transcript state (`ok` / `none` / `blocked` / `error`) as a response header, so programmatic consumers can tell a transient block from a genuinely absent transcript without parsing the body.
- **ScienceDaily lead-image recipe.** A shipped site recipe for `*.sciencedaily.com/releases/**` unwraps the article's `#text` container so the lead image survives extraction. Without it, Readability picks the paragraph-dense inner block as the article and drops the sibling `<figure>` that holds the real lead image. General sites should still rely on the `image` frontmatter field (from `og:image`) for a robust lead-image source.

### Fixed

- **Cache hits now serve complete metadata.** The cached-response path rebuilt a minimal `{title, url, quality}` object, so on a cache hit the frontmatter lost `image` (`og:image`/`twitter:image`), `description`, `author`, `language`, and `site`, and `format=json` returned `metadata: null`. The full metadata persisted at extraction time (in the existing `metadata` column) is now served on cache hits in both the frontmatter and the `format=json` response - no schema change needed. Consumers reading `metadata.ogImage` / `metadata.twitterImage` (e.g. for an article lead image) now get it on cached pages too.
- **Tracking pixels no longer leak into the Markdown.** 1x1 invisible beacon images (e.g. republish/analytics counters embedded inline in article text) were kept by Readability and rendered as bogus Markdown images. `cleanDom` now drops any `<img>` whose declared width and height are both ≤ 1; genuine wide/tall banners (only one tiny dimension) are spared.
- **YouTube: transient 429 distinguished from a missing transcript** (#34, closes #33). A per-IP 429 on the timedtext endpoint was mislabeled as a permanent block; it is now classified honestly and not cached, so a later retry can pick up the now-available transcript.
- **Sidecar: bundle `yt_transcript.py` in the markitdown image** (#35). The YouTube transcript helper was missing from the built image; it is now copied explicitly.

---

## [3.1.0] - 2026-06-15

### Added

- **Dedicated Hacker News pipeline.** Hacker News URLs - item pages, individual comment permalinks, and listings (`/`, `/news`, `/newest`, `/ask`, `/show`, `/jobs`, `/best`) - are now extracted through a purpose-built converter (via the HN API) instead of the generic HTML path. The result is a clean nested comment tree with per-comment permalinks and a `## Comments (N of M)` heading, replacing the layout-table soup the old path produced. Comment depth honors the existing `comment_depth` control, and extraction failures fall back to the generic web pipeline. New `source: hackernews` value and an HN-orange source badge in the PWA.
- **PWA: share the converted Markdown** (Web Share API). A share button next to Copy hands the current Markdown - exactly what is shown and copied, including the frontmatter block when the toggle is on - to the native OS/app share sheet. It appears only where the browser supports Web Share (e.g. mobile, Safari); on a non-cancel failure it falls back to copying so the content is never lost.

### Changed

- **PWA: the Frontmatter toggle updates the output instantly.** Flipping the Frontmatter switch now adds or removes the YAML block immediately, with no second Pull. The Copy and Share buttons and the character count follow the toggle.

---

## [3.0.0] - 2026-06-10

### Breaking

- **Clean markdown body by default.** The inline source-attribution line (`**domain** · fetched` + url, or `**filename** · fetched` for local files) is no longer emitted in the response body. The same applies to Reddit posts: the inline meta line (`**r/sub** · u/user · N ↑ · age · date` + url) is gone from the body; subreddit, author, upvotes, and publish date move into the frontmatter (`subreddit`, `author`, `upvotes`, `published`). The body now starts with `# Title` and goes straight into content. The source URL, fetch date, and all extraction metadata are unaffected - they remain in the YAML frontmatter as before. Set `PULLMD_SOURCE_HEADER=true` to restore the legacy inline header verbatim. Self-hosters upgrading from v2.x should review `MIGRATION.md`.

### Added

- **`PULLMD_FRONTMATTER_FIELDS` allowlist.** Comma-separated list of frontmatter field names to include in the YAML block (e.g. `title,url,source,llm_tokens`). Unset - all fields are emitted (backward-compatible). Unknown names are silently ignored with a one-time startup warning; if every listed name is unknown, the allowlist is ignored and all fields are emitted as a safe fallback.
- **Document conversion via the MarkItDown sidecar** (`MARKITDOWN_URL`). New `POST /api/file` endpoint accepts raw document bytes (25 MB cap) for PDF, DOCX, PPTX, XLSX, EPUB, ZIP, CSV, JSON, XML, and more. Non-HTML URLs detected as documents are also routed through the sidecar automatically in `extractWeb`. If `MARKITDOWN_URL` is unset, the document path is disabled and `/api/file` returns `502`. These features were developed incrementally as versions 2.7.0-2.10.0 on the release branch but are first officially released here in 3.0.0.
- **Opt-in media tier** (`PULLMD_VISION_*` / `PULLMD_STT_*`). Image captioning and audio transcription (Whisper STT) run inside pullmd itself - no markitdown container needed. Per-modality or shared OpenAI-compatible credentials; each modality is enabled when its key is set. The PWA accepts image and audio uploads when the tier is enabled. Off by default; cloud backends cost per call and send content off-host - point `*_BASE_URL` at a local server to keep everything on-host.
- **Keyless YouTube transcripts** (`MARKITDOWN_YOUTUBE=true`). Routes YouTube URLs through the sidecar for title + description + full transcript. No API key required. Configurable timecodes (`yt_timecodes`: `links`/`plain`/`none`), block chunking (`yt_chunk`), preferred languages, and optional proxy. All options are also overridable per-request via query params on `/api` and the MCP `read_url` tool.
- **Opt-in high-quality PDF tier** (`PULLMD_PDF_OCR_API_KEY` / `PULLMD_PDF_OCR_BASE_URL` / `PULLMD_PDF_OCR_MODEL`). Route PDFs through a vendor-neutral OCR provider that preserves tables - reference provider is Mistral OCR (`mistral-ocr-latest`, ~$0.002/page). Triggered per request with `?pdf=ocr` (on `/api`, `/api/stream`, `/api/file`, and the MCP `read_url` tool via `pdf_ocr`) or a recipe `fetch.pdf: ocr` default. Default PDF handling is unchanged (free markitdown path). OCR failures fall back to markitdown automatically. New `source: pdf-ocr` value and `pdf_pages` frontmatter field.
- **LLM-usage and media metadata in frontmatter.** When media or LLM features run, the response frontmatter carries `llm_model`, `llm_tokens`, `llm_prompt_tokens`, `llm_completion_tokens`, `audio_seconds`, `image_size`, and (for YouTube) `duration` and `views`. Media and channel metadata is emitted frontmatter-only - consistent with the v3 clean-body direction.

### Changed

- **Claude Code skill bundle renamed `web-reader` → `pullmd`.** Now served at `GET /pullmd.zip`; the old `/web-reader.zip` URL responds with a permanent redirect. **Existing installs are not replaced by the new zip** - remove the old skill first (`rm -rf ~/.claude/skills/web-reader`) or both will be active side by side. See `MIGRATION.md`.
- The MCP `read_url` tool description and the skill instructions now cover the v3 capabilities (documents, YouTube transcripts, media captioning/transcription, PDF OCR), and the MCP server reports the real package version.
- Media conversion results carry per-modality `source` labels (`image-caption` / `audio-transcript`) instead of a generic `markitdown`.

### Fixed

- **Relative image and link URLs are now resolved against the source page** before extraction. Previously, root-relative paths (e.g. `/images/photo.webp`) survived into the markdown verbatim and rendered as broken images on share pages.
- Document conversions in the markitdown sidecar run in a sandboxed child process with a wall-clock timeout and optional memory cap, so a pathological file can't pin the sidecar (DoS hardening).
- Media frontmatter (image size, LLM usage, YouTube meta) survives the cache - cached responses now carry the same fields as the first request.

---

## [2.6.0] - 2026-06-08

### Added
- **Convert local HTML files** ([#28](https://github.com/AeternaLabsHQ/pullmd/issues/28)). New `POST /api/html` endpoint accepts a raw HTML body (max 10 MB) and runs it through the existing Readability + Trafilatura extraction pipeline — `curl --data-binary @page.html -H 'Content-Type: text/html' …/api/html`. Optional `url=` re-enables site recipes and the linked header; the file name can be passed via `?filename=` or the `X-Filename` header (URI-encoded; keeps names out of access logs); `data:`-URI images (SingleFile exports) are replaced by their alt text. Privacy by design: local files are never cached — no history entry, no share link, and telemetry logs a constant placeholder instead of the file name. Playwright is deliberately unavailable for uploaded HTML (user-supplied markup must never run in a server-side browser).
- **PWA: convert a local `.html` file** - drag-and-drop it onto the page (desktop), or click/tap the dashed hint below the URL field to pick a file. The file picker works on **desktop and mobile**, so a downloaded page can be converted on a phone too. Friendly errors for non-HTML files, oversized files (413), and JavaScript app shells (422).

---

## [2.5.0] - 2026-06-06

### Fixed
- **Sessions no longer die a hard 7 days after login regardless of activity** ([#26](https://github.com/AeternaLabsHQ/pullmd/issues/26)). The session cookie is now re-issued with a fresh `Max-Age` whenever the DB-side sliding expiry bumps (existing once-per-minute throttle), so browser cookie and DB session finally slide together.

### Changed
- **Session TTL raised from 7 to 90 days** (sliding). Anyone active at least once every 90 days stays logged in.
- **Expired session in the PWA now redirects to the login page** instead of showing a bare "Authentication required" error; the requested URL is carried through `/login?next=` and the conversion resumes automatically after login ([#26](https://github.com/AeternaLabsHQ/pullmd/issues/26)).
- **`GET /share` is now auth-gated.** Share intents from a logged-out device go straight to the login page and return to the shared URL after login — no more lost share-target URLs. Instances with `PULLMD_AUTH_MODE=disabled` are unaffected ([#26](https://github.com/AeternaLabsHQ/pullmd/issues/26)).

---

## [2.4.1] - 2026-05-13

### Fixed
- Permalink bar hidden by ad-blockers (e.g. uBlock Origin). Renamed all `share-bar` / `share-url` / `share-copy-btn` CSS classes and IDs to `permalink-bar` / `permalink-url` / `permalink-copy-btn` so cosmetic filter lists no longer suppress the element.
- Service Worker: removed the aggressive forced tab-reload on SW activation that had been introduced as a debugging artifact.

### Changed
- **`:latest` Docker tag now tracks the most recent release again.** The v1 → v2 migration grace period is over; self-hosters who want to pin v1 should use `:1` or `:1.2`.

---

## [2.4.0] - 2026-05-11

### Added
- **Rendered Markdown view in the PWA** (closes [#23](https://github.com/AeternaLabsHQ/pullmd/issues/23), thanks @sladg). New `Raw | Rendered` segmented toggle in the result header lets users see the fetched output as actual formatted HTML (headings, lists, links, images, tables, blockquotes, code blocks) instead of the raw source. Raw remains the default; the chosen mode is persisted in `localStorage` (`pullmd-view-mode`).
  - GFM rendering via self-hosted [marked](https://github.com/markedjs/marked) v12.0.2 (~30 KB).
  - HTML sanitization via self-hosted [DOMPurify](https://github.com/cure53/DOMPurify) v3.4.2 (~20 KB). Strips scripts, inline styles, event handlers, `javascript:` URLs.
  - Rendered links open in a new tab with `rel="noopener noreferrer"`.
  - Lazy first-render: the rendered DOM is only built when the user first switches to Rendered for a given result, so users who only ever copy raw Markdown pay no rendering cost.
  - Copy button still copies the raw Markdown source regardless of the active view.
  - Both themes (dark + paper) styled via existing CSS variables — no new tokens.
- Service Worker precaches the new vendor files (`vendor/marked.min.js`, `vendor/purify.min.js`) so the rendered view also works offline in the installed PWA. `CACHE_NAME` bumped to `pullmd-v20`.

### Notes
- Out of scope for v2.4: syntax highlighting, math/diagrams, Reddit-style spoiler syntax, side-by-side view, rendered view for `/s/:id` share links (still pure `text/markdown`).

---

## [2.3.0] - 2026-05-11

### Added
- **OAuth 2.1 Authorization Code flow** with PKCE-S256 for the claude.ai web custom connector, Claude Desktop's custom-connector dialog, and other MCP-spec-compliant clients (closes [#6](https://github.com/AeternaLabsHQ/pullmd/issues/6), [#10](https://github.com/AeternaLabsHQ/pullmd/issues/10) — thanks @WinFuture23 for raising the Claude Desktop auth gap).
  - Dynamic Client Registration (`POST /oauth/register`, RFC 7591).
  - Authorization endpoint (`GET /oauth/authorize`) with server-rendered consent screen (DE/EN).
  - Token endpoint (`POST /oauth/token`) with `authorization_code` and `refresh_token` grants. Refresh tokens are rotated on every refresh; reuse triggers chain-wide invalidation.
  - Revocation endpoint (`POST /oauth/revoke`, RFC 7009).
  - Discovery: `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
  - Access tokens are HS256 JWTs (`typ: at+jwt`, RFC 9068), audience-bound to `<PUBLIC_URL>/mcp`, 1h TTL. Refresh tokens are opaque, sha256-hashed in storage, 30d TTL.
  - Hardcoded redirect-URI allowlist: `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`.
  - `WWW-Authenticate` 401 responses include the `resource_metadata` parameter pointing at the protected-resource metadata document.
- Rate limiting on `/oauth/token` and `/oauth/authorize` (60 req/min/IP) and `/oauth/register` (10 req/h/IP).
- CORS on `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/.well-known/*`, and `/mcp` (wildcard origin, no credentials — Bearer header travels independently).

### Changed
- `lib/auth.js` middleware accepts a third bearer-token type (OAuth JWT) via an injected verifier. Sessions and API keys (`pmd_*`) continue working unchanged.

### Configuration
- New env var `OAUTH_JWT_SECRET` enables OAuth. Must be 32+ chars. Generate via `openssl rand -hex 32`.
- `PUBLIC_URL` is required when OAuth is enabled (used as JWT `iss`/`aud` and in discovery metadata).

### Migration
- New tables `oauth_clients`, `oauth_auth_codes`, `oauth_refresh_tokens` are created automatically on first boot. No manual SQL.
- OAuth is **opt-in** — without `OAUTH_JWT_SECRET`, behavior is unchanged from v2.2.x. See `MIGRATION.md` for the full upgrade path.

---

## [2.2.0] - 2026-05-06

### Added
- **Site Recipe Engine** (closes [#18](https://github.com/AeternaLabsHQ/pullmd/issues/18)). Declarative `site-recipes.json` for per-host preprocess, fetch, select, and extractor rules. Default recipes ship in the repo (`site-recipes.default.json`); self-hosters can mount `data/site-recipes.json` or set `PULLMD_SITE_RECIPES` to point elsewhere. Four recipe categories:
  - `preprocess` — DOM cleanup actions (`remove-attr`, `remove-class`, `remove-element`, `unwrap`) applied before extraction
  - `fetch` — render forcing (`render: force|skip`), wait-for selector, mobile UA
  - `select` — extra remove-selectors added to `cleanDom`
  - `extractor` — preferred extractor per host (`readability`, `trafilatura`, `playwright`)
- Public endpoint `GET /api/recipes/status` (no auth) — counts loaded/rejected recipes per source for monitoring.
- Cache invalidation on recipe change. When recipe content changes between server boots, all cache rows become stale and re-extract on next access (lazy, on-demand).
- Playwright sidecar accepts new optional fields: `waitFor` (CSS selector), `waitTimeoutMs` (capped at 15 000), `mobileUa` (boolean). Backwards compatible — old fields are silently passed through.
- Initial default recipes covering Future PLC sites (paywall + recommendation widgets — seeded by @WinFuture23's analysis in [#17](https://github.com/AeternaLabsHQ/pullmd/issues/17)) and GitHub Issues (JS-rendered comments).
- Playwright sidecar bundles `playwright-stealth` to mitigate `navigator.webdriver`-style headless detection on JS-driven anti-bot pages.

### Known limitations
- Sites behind cookie-based consent walls (third-party CMP frameworks like TCF v2) are not unlocked by recipes alone in this release. Such sites redirect non-consenting visitors to a JS-rendered consent UI and only return article content once HttpOnly cookies are set after a click. Write a custom recipe with whatever combination of `select.remove`, `extractor`, and `fetch` settings works for your specific source.

---

## [2.1.0] - 2026-05-05

### Added
- PWA: persist frontmatter toggle, comments toggle and comment depth across reloads via `localStorage` (keys `pullmd-frontmatter`, `pullmd-comments`, `pullmd-comment-depth`). Closes [#20](https://github.com/AeternaLabsHQ/pullmd/issues/20).
- PWA: scroll to top when selecting a history/archive entry, so the new content is visible after click. Closes [#19](https://github.com/AeternaLabsHQ/pullmd/issues/19).

---

## [2.0.0] - 2026-05-02

> **Breaking:** PullMD now supports an authentication system. Existing installs keep working unchanged (default `PULLMD_AUTH_MODE=disabled`); operators who want auth must follow [`MIGRATION.md`](./MIGRATION.md).

> **Pulling v2.x:** Through 2026-05-13, `:latest` continued pointing at v1.x. Since v2.4.1 the `:latest` tag tracks v2.x again; self-hosters who want to stay on v1 should pin `:1` or `:1.2`.

### Added
- Three auth modes (`disabled` / `single-admin` / `multi-user`) controlled by `PULLMD_AUTH_MODE`.
- Web sessions: `POST /login`, `POST /logout`, `GET /signup`, `GET /api/me`, server-rendered HTML for `/login` and `/signup`.
- Per-user API keys: `pmd_<32-char-base62>` format, sent as `Authorization: Bearer pmd_xxx`. Manage at `/settings`. Stored as SHA-256 hashes.
- Per-user history: `/api/history` and `/api/archive` are scoped to `req.user` when authenticated.
- Admin CLI: `node scripts/admin.js {list-users,reset-password,make-admin}`.
- Schema: `users`, `sessions`, `api_keys`, `user_fetches` tables, plus `conversions.user_id`.
- Argon2id password hashing.

### Changed
- `/api`, `/api/stream`, `/mcp`, `/api/history`, `/api/archive`, `/api/cache/:id`, `DELETE /api/cache` require auth when mode != `disabled`.
- `/s/:id` share links remain public in all modes (design choice).
- `/api/config` now exposes `authMode`.

### Deprecated
- `PULLMD_AUTH_TOKEN` (legacy bearer compat) — works only in `single-admin` mode, removed in v3.0.

### Security
- Internal v2.0 security review (`REVIEW-FINDINGS.md` in the v2.0 release commit) tightened `DELETE /api/cache*` to admin-only in non-`disabled` modes and stopped flashing new API keys through URLs.

### Migration
See `MIGRATION.md`.

---

## [1.2.0] - 2026-05-02

### Added
- **User-Agent rotation** from a real-world UA pool with static seed fallback (closes [#14](https://github.com/AeternaLabsHQ/pullmd/issues/14), thanks @WinFuture23). Sites that silently degraded responses to the previous hardcoded Chrome 131 UA now extract cleanly.
- **Charset detection from HTML meta tags** when `Content-Type` lacks a `charset` directive (closes [#8](https://github.com/AeternaLabsHQ/pullmd/issues/8), thanks @WinFuture23). Eliminates mojibake on legacy ISO-8859-1 pages (e.g. `winfuture.de`).
- **Share URL embedded in MCP frontmatter responses** so LLMs stop hallucinating `pullmd.com` as the host instead of the operator's actual instance (closes [#1](https://github.com/AeternaLabsHQ/pullmd/issues/1), [#9](https://github.com/AeternaLabsHQ/pullmd/issues/9), thanks @looselyhuman and @WinFuture23).
- **HTML preprocessing** to recover dropped paragraphs adjacent to inline recommendation widgets, plus per-host extractor override (closes [#17](https://github.com/AeternaLabsHQ/pullmd/issues/17), thanks @WinFuture23 — analysis that later seeded the v2.2 recipe engine).
- **GHCR mirror** for all three images alongside Docker Hub (closes [#13](https://github.com/AeternaLabsHQ/pullmd/issues/13), thanks @Kampe).
- `DISABLE_PUBLIC_HISTORY` env var to hide the history/archive views on shared instances (closes [#7](https://github.com/AeternaLabsHQ/pullmd/issues/7)).

### Fixed
- **Reddit threads with embedded images:** post selftext now renders before the media block, so the header is visible alongside the image and the comment tree is no longer truncated (closes [#12](https://github.com/AeternaLabsHQ/pullmd/issues/12)).
- **Docker volume mount path:** `/app/data` corrected to `/data` so the documented bind mount actually works (closes [#15](https://github.com/AeternaLabsHQ/pullmd/issues/15), PR [#16](https://github.com/AeternaLabsHQ/pullmd/pull/16) — thanks @andrewthetechie).

---

## [1.1.3] - 2026-04-29

### Fixed
- **MCP response shape:** `read_url`, `get_share`, `list_recent` no longer return `structuredContent` alongside `content[0].text`. Claude Code and other MCP clients were surfacing the metadata JSON instead of the actual Markdown (closes [#1](https://github.com/AeternaLabsHQ/pullmd/issues/1), originally reported by @looselyhuman; upstream Anthropic bug tracked at `anthropics/claude-code#54450`).
- **Reddit images:** image renders before selftext to match Reddit's visual order, so the header/title isn't suppressed by the image preview.
- CI matrix corrected so all three images (pullmd, pullmd-trafilatura, pullmd-playwright) properly publish to Docker Hub at `:1.1.3` / `:1.1` / `:1` / `:latest`, alongside GHCR.

---

## [1.1.2] - 2026-04-27

### Added
- Delete button in the recents list on the homepage. Each row gets a discreet `×` on hover — same one-click pattern as the archive view. `opacity: 0` by default, fades in on row hover.

### Changed
- `cache.history()` now includes the row `id` so the PWA can issue `DELETE /api/cache/:id` straight from the recents list.
- Service Worker cache bumped v17 → v18.

---

## [1.1.1] - 2026-04-27

### Fixed
- **Readonly `<input>` values surface as `<code>`.** Click-to-copy widgets on CMS-driven sites (API model slugs, embed snippets, share links) used to hide their content in `<input type="text" readonly value="…">`, which `node-html-markdown` silently dropped as form chrome. They now come through as inline code. Only `readonly` text inputs are transformed; real forms are untouched.
- **Bare-UUID alt-text on images is dropped.** Strapi/Directus/Hygraph etc. leak asset IDs as the `alt` attribute. A strict UUID-v4 regex on the alt — drop the alt only, keep the image link. Descriptive alt text is preserved.

### Verified
- Diffed against 9 representative URLs (paulgraham.com, hillelwayne.com, 12factor.net, joelonsoftware.com, grugbrain.dev, RFC 2324, Wikipedia, HN frontpage) → byte-identical output. mistral.ai/pricing → expected diff (model slugs now `code`, UUID alts dropped).

---

## [1.1.0] - 2026-04-27

### Added
- **Playwright fallback for JavaScript-rendered pages.** When Readability + Trafilatura returns body-soup or low-quality output, the pipeline retries via headless Chromium and re-extracts on the rendered DOM. Source label is `playwright`; predicate reason is preserved in `metadata.extractorReason`.
- **New Python sidecar `pullmd-playwright`** (FastAPI + Chromium, `asyncio.Semaphore` concurrency limit, 20 s hard timeout, soft-fail networkidle wait). Optional — leave `PLAYWRIGHT_URL` unset and the pipeline silently degrades to static extraction.
- **Live status events for the PWA via Server-Sent Events.** New `GET /api/stream` endpoint emits `fetching → extracting → (rendering) → result`. Other clients (`curl`, Claude, MCP) continue to use `/api` unchanged.
- `lib/render-decision.js` — predicate over (i) readability fellback + thin, (ii) body-soup signature heading/paragraph ratio, (iii) low-quality safety net.
- `?render=force` and `?render=skip` manual overrides on both `/api` and `/api/stream`.
- Frontend status line under the spinner with i18n (DE/EN); EventSource auto-falls-back to plain fetch on transport failure.
- `client_mode` query-param fallback so PWA-originated SSE requests keep their attribution.
- Cache-ordering fix from the unreleased v1.0.3 included here: re-fetched URLs bubble to the top of the recents list.

### Operator notes
- The Playwright sidecar image is ~3.7 GB on disk (pulls Chromium on first build).
- `/api/stream` and `?render=force` are not rate-limited — recommended to keep PullMD behind an authenticating reverse proxy when exposed to the public internet.

---

## [1.0.2] - 2026-04-27

### Added
First public release. Self-hosted URL → Markdown service for humans and AI agents — PWA, REST, MCP, and a downloadable Claude Code skill, all from one container.

- **Multi-strategy extraction.** Cloudflare's native Markdown endpoint where available; Readability + Trafilatura running in parallel, picked by quality score elsewhere.
- **Reddit-aware path.** Auto-detects threads (incl. `redd.it` and `/s/` share links), returns post + nested comment tree with tunable `comment_depth` / `comment_limit`.
- **Refreshable share IDs.** Every conversion gets an 8-hex permalink; `GET /s/:id` re-fetches if older than 1h, falls back to the last good snapshot if the source dies.
- **Four interfaces, one codebase.** PWA frontend, REST (`/api`), MCP (`POST /mcp`, Streamable-HTTP), downloadable Claude Code skill bundle.
- **Multi-arch images** (`linux/amd64`, `linux/arm64`) on Docker Hub.

### Fixed
- First-boot DB file error on Docker volume mounts (thanks @goran-zdjelar, [#2](https://github.com/AeternaLabsHQ/pullmd/issues/2)).

---

[3.10.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.10.0
[3.9.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.9.0
[3.8.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.8.0
[3.7.1]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.7.1
[3.7.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.7.0
[3.6.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.6.0
[3.0.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v3.0.0
[2.6.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.6.0
[2.5.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.5.0
[2.4.1]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.4.1
[2.4.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.4.0
[2.3.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.3.0
[2.2.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.2.0
[2.1.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.1.0
[2.0.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.0.0
[1.2.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.2.0
[1.1.3]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.3
[1.1.2]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.2
[1.1.1]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.1
[1.1.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.0
[1.0.2]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.0.2
