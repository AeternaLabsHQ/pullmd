# Site recipes — contributor guide

A **site recipe** is a small declarative JSON entry that adjusts how PullMD
extracts a page for URLs matching a host/path pattern. Recipes never contain
code. They tune the generic pipeline: force a browser render, strip noisy
elements, unwrap wrappers that confuse the reader, or pull structured data
(JSON-LD or CSS selectors) into the YAML frontmatter.

This guide is self-contained. Following it end to end, you can write, test, and
submit a recipe for a site you have never seen before, using nothing but this
document and the repository.

---

## Table of contents

1. [When you need a recipe](#1-when-you-need-a-recipe)
2. [Where recipes live and how they load](#2-where-recipes-live-and-how-they-load)
3. [Matching and merge semantics](#3-matching-and-merge-semantics)
4. [Schema reference](#4-schema-reference)
5. [JS-heavy and bot-protected sites (rendered DOM)](#5-js-heavy-and-bot-protected-sites-rendered-dom)
6. [Structured data (JSON-LD) into frontmatter](#6-structured-data-json-ld-into-frontmatter)
7. [Cleaning noisy output](#7-cleaning-noisy-output)
8. [A complete annotated example](#8-a-complete-annotated-example)
9. [The four built-in recipes](#9-the-four-built-in-recipes)
10. [Testing your recipe](#10-testing-your-recipe)
11. [Contributing checklist](#11-contributing-checklist)

---

## 1. When you need a recipe

The generic pipeline (fetch → Readability + Trafilatura → optional Playwright
re-render → Markdown) already handles most sites well. Reach for a recipe only
when a *specific site* consistently produces bad output that a *general* fix
would not address. Typical signals:

- The raw HTTP response is an empty JS shell or a bot-challenge page, so the
  real article never reaches the extractor. → force a browser render.
- A recommendation rail, "you may also like" block, or paywall scaffold keeps
  leaking into the Markdown. → remove those elements.
- The extractor picks the wrong container as the article (e.g. it grabs a
  paragraph-dense inner block and drops the lead image). → unwrap or restructure
  the offending element.
- The page embeds clean structured data (author, publish date, rating) that you
  want promoted into the frontmatter. → map JSON-LD or selectors into frontmatter
  fields.

If the same problem affects many unrelated sites, prefer a general improvement
to `lib/web.js` instead of a per-site recipe. Recipes are the right tool for
site-specific quirks.

**IMPORTANT: recipes only apply to the general web-page extraction path**
(Readability/Trafilatura, and its Playwright-rendered second pass). Several
other pipeline branches decide the outcome before a recipe ever gets a look and
silently ignore `preprocess`, `select.remove`, the `frontmatter` block, and even
`fetch.render: "force"`: Cloudflare's markdown endpoint (short-circuits on a
`text/markdown` response), Reddit and Hacker News (dedicated extractors),
YouTube transcripts, media files (image/audio captioning), and document
conversions (markitdown / PDF OCR). If you're writing a recipe for a URL that
falls into one of these, the recipe is a no-op — see the troubleshooting note
in [§10](#10-testing-your-recipe) for how to tell which path actually served
your request.

---

## 2. Where recipes live and how they load

There are two recipe sources. Both are JSON arrays of recipe objects.

| Source | Path | Purpose |
| ------ | ---- | ------- |
| **Built-ins** (what you PR) | `site-recipes.default.json` (repo root) | Shipped to every install. Adding a recipe here helps everyone. This is the file a contributor edits. |
| **Self-host overlay** | `data/site-recipes.json`, or a path set in `PULLMD_SITE_RECIPES` | Operator-local recipes, not shipped. Handy for iterating on a new recipe locally before moving the finished entry into the default file. |

Resolution of the overlay path: if `PULLMD_SITE_RECIPES` is set, that path is
used. Otherwise, if `data/site-recipes.json` exists (relative to the working
directory), it is picked up automatically. If neither is present, only the
built-in file loads.

### Loading rules

- **Boot-time only.** Both files are read once when the server starts. Editing a
  recipe file has no effect until you restart the server.
- **Root must be a JSON array.** A file whose top-level value is not an array is
  rejected wholesale (with a warning) and contributes zero recipes.
- **Per-recipe validation.** Each entry is validated independently. An invalid
  entry is rejected on its own — the *whole* recipe is dropped, not just the bad
  field — and the remaining valid entries still load. The schema is **strict**:
  any unknown top-level key rejects that recipe.
- **Duplicate names within one file:** the later entry wins; the earlier one is
  discarded.
- **Across the two files:** the default file and the overlay are *concatenated*,
  not deduplicated. A recipe in the overlay with the same `name` as a built-in
  does **not** replace it — both are kept, both can match a URL, and they merge
  together (see [§3](#3-matching-and-merge-semantics)). To truly override a
  built-in from the overlay, give the overlay recipe a `host`/`path` that matches
  the same URLs and set the scalar fields you want to win (last-wins merge
  applies because the overlay is processed after the default file).
- **Cache invalidation is automatic.** PullMD hashes the recipe files at boot.
  When the content changes across a restart, previously cached conversions are
  invalidated so pages re-extract under the new rules. (The very first boot does
  not invalidate — existing cache rows stay valid until you actually change a
  recipe.)

### First debugging stop: `GET /api/recipes/status`

After every restart, check this endpoint. It is the ground truth for what
loaded:

```json
{
  "ok": true,
  "loaded": 4,
  "rejected": 0,
  "sources": [
    { "path": ".../site-recipes.default.json", "loaded": 4, "rejected": 0 }
  ],
  "filteredFrontmatterFields": []
}
```

- `loaded` / `rejected` — totals across all sources.
- `sources` — per-file counts, so you can tell whether your overlay was even
  found and how many of its entries passed.
- `ok` is `true` only when `rejected` is `0`.
- `filteredFrontmatterFields` — recipe frontmatter fields dropped by the
  `PULLMD_FRONTMATTER_FIELDS` allowlist (see [§6](#6-structured-data-json-ld-into-frontmatter)).
  If a custom frontmatter field vanishes from your output, look here first.

If a recipe you added does not appear in `loaded`, read the server's startup log:
each rejection is printed as `[recipes] <file> — recipe #<n> rejected: <reason>`
with the exact schema path and message.

---

## 3. Matching and merge semantics

This is the part people get wrong most often. Read it carefully.

### Matching

A recipe matches a URL when **both** its `host` and its `path` match.

**`host`** — a string or an array of strings. Globs use `*`, which matches any
sequence of characters *including dots*. Matching is case-insensitive. All other
characters are literal (a `.` matches only a literal dot).

- `example.com` matches exactly `example.com`.
- `*.example.com` matches `foo.example.com` and `foo.bar.example.com`, but **not**
  the apex `example.com` (add it explicitly if you need it).
- `["a.example.com", "b.example.com"]` matches either host (any-of).

**`path`** — a glob against the URL pathname. Two wildcards, with different
meaning:

- `*` matches exactly **one** path segment (no slashes). `/foo/*` matches
  `/foo/bar` but not `/foo/bar/baz` and not `/foo/`.
- `**` matches **anything**, across segment boundaries. `/foo/**` matches
  `/foo/a`, `/foo/a/b/c`, and any deeper path, but **not** the bare `/foo` (the
  slash before `**` is required). To also cover the bare section root, add a
  second recipe entry with `path: "/foo"` — all matching recipes are merged
  (see below).
- Default is `/**` (matches every path) when `path` is omitted.
- Path matching is anchored and case-sensitive.

Example: `path: "/*/*/issues/*"` matches `/owner/repo/issues/123` (four fixed
segments) but not `/owner/repo/pulls/1`.

### Merge — ALL matching recipes apply

PullMD does **not** pick a single best recipe. Every recipe whose host and path
match is collected and **merged** into one effective recipe. The merge rules:

| Field | Merge behavior |
| ----- | -------------- |
| `preprocess` | Arrays **concatenate**, in recipe order. |
| `select.remove` | Arrays **concatenate**. |
| `extractor` | Scalar, **last-wins**. |
| each `fetch.*` key (`render`, `wait_for`, `wait_timeout_ms`, `mobile_ua`, `pdf`) | Merged **per key**, last-wins on a per-key collision. Setting `wait_for` in one recipe and `mobile_ua` in another gives you both. |
| `frontmatter.jsonld` | Scalar, **last-wins**. |
| `frontmatter.fields` | Merged **key-wise**: disjoint keys from several recipes all apply; on a colliding key the later recipe wins. |

"Recipe order" and "later" mean the order recipes appear across the loaded files
(default file first, then overlay), then array index within a file.

### Pattern: split unrelated concerns into separate recipes

Because all matches merge, you can — and should — keep one recipe focused on one
concern even when several apply to the same host. The two `future-plc-*`
built-ins demonstrate this: one recipe strips paywall scaffolding via
`preprocess`, a second removes recommendation widgets via `select.remove`, both
targeting the same six hosts. Splitting keeps each recipe small, reviewable, and
independently testable, and the merge combines them at match time.

---

## 4. Schema reference

Every field below is validated at load time. The object is **strict** — an
unknown key rejects the whole recipe.

| Field | Type | Default | Use this when |
| ----- | ---- | ------- | ------------- |
| `name` | string (non-empty) | — (required) | A unique, human-readable id. Used in logs, status, and duplicate detection. |
| `host` | string, or non-empty array of strings | — (required) | Host glob(s) the recipe applies to. See [§3](#3-matching-and-merge-semantics). |
| `path` | string (non-empty) | `/**` | Restrict to a path glob (e.g. articles only). |
| `preprocess` | array of action objects | `[]` | Structural HTML edits before extraction (see below). |
| `select` | object `{ remove: string[] }` | `{ remove: [] }` | CSS selectors of elements to delete before extraction. |
| `extractor` | `"readability"` \| `"trafilatura"` \| `"playwright"` | (unset) | Force a specific extractor and skip the quality auto-pick. |
| `fetch` | object (see below) | `{}` | Control fetching / rendering. |
| `frontmatter` | object (see [§6](#6-structured-data-json-ld-into-frontmatter)) | (unset) | Inject custom frontmatter fields from JSON-LD / selectors. |

### `preprocess` actions

Each action is an object with an `action` discriminator. They run in order, on
the HTML, **before** the content extractor sees it. Selectors are standard CSS
(cheerio). The four actions:

| Action | Required keys | What it does | Typical use |
| ------ | ------------- | ------------ | ----------- |
| `remove-attr` | `selector`, `attr` | Removes the named attribute from every matching element (keeps the element). | Strip an `aria-hidden="true"` that hides real body text from the extractor. |
| `remove-class` | `selector`, `class` | Removes one class token from `class`, preserving the others; drops the `class` attribute entirely if it was the only token. | Remove a `paywall` class that triggers CSS-hiding of the article body. |
| `remove-element` | `selector` | Deletes the matching element and all its descendants. | Delete an inline advertisement or embed wrapper. |
| `unwrap` | `selector` | Replaces the element with its children (the element's tags vanish, its contents stay in place). | Flatten a wrapper `<div>` that makes Readability treat the real article as a sibling and drop the lead image. |

### `fetch`

All keys optional; the object is strict.

| Key | Type | Constraints | Meaning |
| --- | ---- | ----------- | ------- |
| `render` | `"force"` \| `"skip"` | — | `force`: always render the page in the Playwright browser sidecar and extract from the rendered DOM. `skip`: never render, even if the auto-heuristic would. |
| `wait_for` | string (CSS selector) | non-empty | On a render, wait until this selector appears before capturing the DOM. Use for content injected late by JS. Only takes effect when the page is rendered. |
| `wait_timeout_ms` | integer | `0`–`15000` | Max time to wait for `wait_for`. Only takes effect when the page is rendered. |
| `mobile_ua` | boolean | — | Render with a mobile User-Agent (some sites serve a lighter, cleaner mobile DOM). Only takes effect when the page is rendered. |
| `pdf` | `"ocr"` | — | For PDF URLs, route through the high-quality OCR tier (if the operator configured an OCR provider) instead of the default document path. |

### `extractor` values

- `"readability"` — force the Mozilla Readability extractor; skip the Trafilatura
  sidecar and the quality comparison.
- `"trafilatura"` — prefer the Trafilatura sidecar result. (If the sidecar is
  unavailable, PullMD falls back to Readability and notes it.)
- `"playwright"` — **also forces a browser render** (equivalent to
  `fetch.render: "force"`), then extracts from the rendered DOM. Use this when a
  site is unusable without JavaScript.

---

## 5. JS-heavy and bot-protected sites (rendered DOM)

A plain HTTP `GET` returns whatever the server sends before any JavaScript runs.
For single-page apps, lazy-loaded articles, or bot-challenged pages, that is
often an empty shell or a challenge screen — the real content never reaches the
extractor.

To get the content the *browser* would see, make PullMD render the page in its
Playwright sidecar and extract from the rendered DOM. Two equivalent switches:

```json
{ "name": "spa-site", "host": "app.example.com", "fetch": { "render": "force" } }
```

```json
{ "name": "spa-site", "host": "app.example.com", "extractor": "playwright" }
```

For content that appears only after an XHR settles, tell the renderer what to
wait for:

```json
{
  "name": "late-loading",
  "host": "news.example.com",
  "path": "/article/**",
  "fetch": { "render": "force", "wait_for": ".article-body", "wait_timeout_ms": 5000 }
}
```

**Crucial detail:** on the rendered pass, **all** recipe processing re-runs
against the *rendered* HTML — `preprocess` actions, `select.remove`, and
`frontmatter` extraction all execute again on what the browser produced, not on
the raw response. So author your selectors and JSON-LD paths against the rendered
DOM (see [§10](#10-testing-your-recipe) for how to capture it), and they will
match what the pipeline actually processes.

> The Playwright render is available only on the URL-fetch path (`GET /api`,
> `GET /api/stream`, MCP `read_url`). It is deliberately **not** used for
> locally-supplied HTML (`POST /api/html`, `POST /api/file`), which never runs in
> a server-side browser.

---

## 6. Structured data (JSON-LD) into frontmatter

### What JSON-LD is

Many pages embed a machine-readable description of themselves in a
`<script type="application/ld+json">` block: a JSON object using the
[schema.org](https://schema.org) vocabulary (`Article`, `NewsArticle`, `Recipe`,
`Product`, `Person`, …). Search engines read it. Because it is authored by the
site itself, it is usually cleaner and more reliable than scraping visible text
— which makes it an excellent source for frontmatter fields like author, publish
date, or rating.

Frontmatter fields appear only when the request asks for them
(`GET /api?url=...&frontmatter=true`), inside the leading YAML block. They are
never inserted into the Markdown body.

### The `frontmatter` block

```json
"frontmatter": {
  "jsonld": { "type": "Article" },
  "fields": {
    "author":    { "jsonld": "author.name" },
    "published": { "jsonld": "datePublished" },
    "rating":    { "selector": ".rating-value" }
  }
}
```

- `frontmatter.jsonld.type` — the schema.org `@type` to select the source node
  from (see resolution rules below). Required *only* if at least one field uses a
  `jsonld` source; a selector-only block may omit it.
- `frontmatter.fields` — a non-empty map of **output field name → source
  descriptor**. Each descriptor has **exactly one** of:
  - `jsonld` — a dot-path into the selected JSON-LD node, or
  - `selector` — a CSS selector; the field takes the trimmed text of the first
    match.

  Specifying both, or neither, rejects the recipe.

### JSON-LD node selection and path resolution (exact semantics)

1. **All** `<script type="application/ld+json">` blocks are parsed, in document
   order.
2. **Per-block error tolerance:** each block is parsed in its own try/catch. A
   malformed block is skipped; it never breaks extraction or the other blocks.
3. **Candidate collection:** top-level arrays contribute their elements; an
   object contributes itself; a `@graph` array contributes its entries (after the
   containing object). Nested arrays/`@graph` are traversed recursively.
4. **Type match:** a candidate matches when its `@type` equals your configured
   `type` **exactly and case-sensitively**, or its `@type` is an array that
   **includes** that string. (`article` will not match `Article`.)
5. **First match wins:** the first candidate in document order that matches is the
   node all `jsonld` fields read from.
6. **Dot-path resolution:** each `.`-separated step descends one key. Whenever a
   step lands on an **array**, resolution continues into that array's **first
   element** — at every step *and* for the final value. So `authors.name` on
   `authors: [{name:"Ada"}, …]` resolves to `"Ada"`, and a final `tags` that is
   `["a","b"]` resolves to `"a"`.
7. **Primitive-only final value:** the resolved value must be a string, number,
   or boolean. If the path is missing, or lands on an object/array-of-objects, or
   anything non-primitive, the field is **silently omitted** — no empty key, no
   error.

### `selector` source

The field takes the **trimmed text of the first matching element**. If nothing
matches, or the text is empty after trimming, the field is silently omitted.
Selectors run against the same (rendered, if applicable) DOM the content
extractor uses, *before* boilerplate stripping, so you can target elements that
would otherwise be removed as chrome.

Frontmatter field extraction (both JSON-LD and selector sources) runs **after**
`preprocess` actions on the same HTML, so an element removed by a `preprocess`
action is invisible to selector and JSON-LD sources. In particular, don't aim a
`preprocess` removal at a broad wrapper that happens to contain the
`<script type="application/ld+json">` block (or an element a frontmatter selector
reads) — the field silently vanishes from the output with no error.

### Field-name rules

Output field names must match this regex:

```
^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
```

That is: start with an ASCII letter, then letters, digits, underscores, or
hyphens, up to 64 characters total.

**Reserved names (rejected at load time).** A recipe may not define a field with
a name the pipeline computes itself — provenance, share/cache bookkeeping, and
media/LLM-usage fields. Using one rejects the recipe with a clear message
(`frontmatter field name "<x>" is reserved`). The reserved set:

```
url, source, fetched, quality, extractor_reason, share_id, share_url,
duration, views, image_size, audio_seconds, pdf_pages, subreddit, upvotes,
llm_model, llm_tokens, llm_prompt_tokens, llm_completion_tokens,
cached, refreshed, age_ms
```

**Overridable names (allowed; recipe value wins).** These metadata-derived fields
are normally scraped from generic `<title>`/`og:`/`meta`/`twitter:` tags. A
recipe *may* define them; on a collision the recipe value replaces the generic
one (site-specific knowledge beats generic scraping):

```
title, author, published, modified, description, language, image, site
```

Any other name that matches the regex and is not reserved is a fresh custom
field (e.g. `rating`, `price`, `reading_time`).

### Operator allowlist: `PULLMD_FRONTMATTER_FIELDS`

Operators can restrict which frontmatter fields are emitted, via a comma-
separated `PULLMD_FRONTMATTER_FIELDS` env var:

- **Unset** → all fields flow, including your recipe fields.
- **Set** → it acts as a strict allowlist. A recipe field whose name is not
  listed **verbatim** is dropped from the output. (List your custom field name
  exactly to keep it.)

When the allowlist drops a recipe field, it is visible in two places: a startup
log warning (`[recipes] recipe "<name>": frontmatter field(s) dropped by
PULLMD_FRONTMATTER_FIELDS allowlist: <fields>`) and the
`filteredFrontmatterFields` array of `GET /api/recipes/status`. **If a
frontmatter field you defined does not show up in the output, check
`/api/recipes/status` there first** — a set allowlist is the usual cause.

> Note: `PULLMD_FRONTMATTER_FIELDS` also emits a separate startup warning listing
> any names it does not recognise as built-ins. Your custom recipe field names
> will appear in that "unknown" warning — this is expected and harmless; the
> field is still kept for recipe output as long as you listed it.

One corner case worth knowing: if the allowlist contains **only** names unknown
to the built-in set (e.g. just your custom recipe field, no built-in names
listed), the built-in allowlist deactivates entirely and all built-in fields
are emitted anyway — "only my custom field, no built-ins" is not expressible.
This is pre-existing behavior of the built-in-field allowlist, not a bug in
your recipe.

---

## 7. Cleaning noisy output

When extraction leaves recommendation rails, duplicated blocks, hidden paywall
scaffolding, or tracking junk in the Markdown, remove it at the **HTML stage**.
There is no Markdown post-processing step by design — content-noise removal
happens before extraction, so choose your selectors against the (rendered, if
applicable) DOM.

Two tools, pick by intent:

- **`select.remove`** — a flat list of CSS selectors whose elements are deleted.
  This is the go-to for "delete these boilerplate blocks": ad slots, related-
  articles asides, share bars, comment widgets.

  ```json
  "select": { "remove": ["aside.related", "div.newsletter-signup", "[data-widget=\"recommendations\"]"] }
  ```

  Selectors are applied one by one; an invalid selector is skipped and never
  breaks extraction of the rest of the page.

- **`preprocess` with `remove-element`** — same end result in the body (the
  element is deleted), but at a different point in the pipeline: `preprocess`
  removals happen before metadata and frontmatter extraction, so the removed
  element is invisible to frontmatter selector/JSON-LD sources too, whereas
  `select.remove` runs after frontmatter extraction and only strips the element
  from what the content extractors see. `remove-element` also lives in the
  ordered `preprocess` pipeline, so use it when the deletion must
  happen relative to other structural edits (e.g. unwrap a parent first, then
  delete a now-exposed child). For a simple "just delete these", `select.remove`
  is clearer.

- **`preprocess` with `unwrap`** — for a wrapper element that isn't noise itself
  but *confuses* the extractor. Readability scores containers; a stray wrapper can
  make it treat the real article as a sibling and drop the lead image or split the
  body. `unwrap` removes the wrapper's tags while keeping its contents, flattening
  the structure so the extractor sees one coherent article.

- **`remove-attr` / `remove-class`** — for attributes/classes that *hide* real
  content (e.g. `aria-hidden="true"`, a `paywall` CSS class) rather than elements
  that *are* noise. You keep the element and its text; you just strip the marker
  that was suppressing it.

**Execution order:** `preprocess` actions run first (on the raw HTML, before
parsing and metadata extraction), then frontmatter fields are extracted, then
`select.remove` runs — before both extractors (Readability and Trafilatura
alike). Practical consequence: a `preprocess` `unwrap` can dissolve a wrapper
that a `select.remove` selector would otherwise target, and nothing
`select.remove` does can affect the `preprocess` stage or the frontmatter.

PullMD already removes generic chrome (nav, header, footer, sidebars, cookie
banners, share buttons, 1×1 tracking pixels, …) on every page. Only add
selectors for noise that survives that generic pass on your specific site.

---

## 8. A complete annotated example

A generic template exercising host arrays, a path glob, forced rendering with a
wait, two preprocess actions, `select.remove`, and a `frontmatter` block with
both a JSON-LD and a selector field. Copy this and adapt.

```json
{
  "name": "news-example-articles",
  "host": ["www.news.example.com", "news.example.com"],
  "path": "/articles/**",
  "fetch": {
    "render": "force",
    "wait_for": ".article-body",
    "wait_timeout_ms": 5000
  },
  "preprocess": [
    { "action": "remove-attr", "selector": "p[aria-hidden=\"true\"]", "attr": "aria-hidden" },
    { "action": "unwrap", "selector": "div.article-wrapper" }
  ],
  "select": {
    "remove": ["aside.you-may-like", "div.newsletter-cta"]
  },
  "frontmatter": {
    "jsonld": { "type": "NewsArticle" },
    "fields": {
      "author":       { "jsonld": "author.name" },
      "published":    { "jsonld": "datePublished" },
      "reading_time": { "selector": ".reading-time" }
    }
  }
}
```

Field-by-field:

| Part | Effect |
| ---- | ------ |
| `name` | Unique id shown in logs and `/api/recipes/status`. |
| `host` (array) | Applies to both the `www.` and bare host. |
| `path: "/articles/**"` | Only article pages, any depth below `/articles/`. |
| `fetch.render: "force"` | Always render in the Playwright sidecar; extract from the rendered DOM. |
| `fetch.wait_for` / `wait_timeout_ms` | Wait up to 5 s for `.article-body` to appear before capturing. |
| `preprocess[0]` `remove-attr` | Strips `aria-hidden` so hidden body paragraphs become visible to the extractor. |
| `preprocess[1]` `unwrap` | Flattens `div.article-wrapper` so Readability treats the article as one container. |
| `select.remove` | Deletes the "you may like" rail and a newsletter call-to-action. |
| `frontmatter.jsonld.type` | Selects the first `NewsArticle` JSON-LD node. |
| `author` field | JSON-LD dot-path `author.name` (descends into the first author if it is an array). |
| `published` field | JSON-LD `datePublished`. |
| `reading_time` field | Trimmed text of the first `.reading-time` element. |

Requested as `GET /api?url=https://news.example.com/articles/foo&frontmatter=true`,
the output begins with a YAML block including `author:`, `published:`, and
`reading_time:` (each present only if it resolved).

---

## 9. The four built-in recipes

The shipped `site-recipes.default.json` is the best reference for real, working
recipes. Each demonstrates a different feature:

| Recipe | Demonstrates |
| ------ | ------------ |
| `future-plc-paywall-aria` | `preprocess` with `remove-attr` + `remove-class` — strips `aria-hidden` and a `paywall` class that suppress the article body across several hosts (`host` array). |
| `future-plc-recommendations` | `select.remove` — deletes recommendation rails on the same hosts. Split from the paywall recipe to keep one concern per recipe (they merge at match time). |
| `github-issues` | `fetch.render: "force"` + `wait_for` + `wait_timeout_ms` and a multi-segment `path` glob (`/*/*/issues/*`) — renders JS-loaded issue comments. |
| `sciencedaily-lead-image` | `preprocess` with `unwrap` and a `path` glob (`/releases/**`) — unwraps a `#text` container so Readability keeps the lead image instead of dropping it. |
| `claude-blog-split-body` | `preprocess` with `unwrap` — flattens two CMS wrapper layers so the article's two body containers become siblings. Readability picks a single top candidate plus its siblings, so a body split across separate branches loses everything outside the winning branch. |

---

## 10. Testing your recipe

### Manual loop

1. **Add your recipe** to the overlay file (`data/site-recipes.json`, or the path
   in `PULLMD_SITE_RECIPES`) while iterating — it is faster than editing the
   shipped file and keeps your work-in-progress separate. Move the finished entry
   into `site-recipes.default.json` for the PR.
2. **Start (or restart) the server:** `npm start`. Recipes load only at boot, so
   restart after every edit.
3. **Confirm it loaded:** `GET /api/recipes/status` — your recipe should be
   counted in `loaded` (and its source in `sources`). If not, read the startup log
   for the rejection reason.
4. **Convert a real URL, bypassing the cache** so each attempt re-extracts:
   ```
   GET /api?url=https://news.example.com/articles/foo&nocache=1&frontmatter=true
   ```
   `nocache=1` (or `nocache=true`) skips the 1-hour cache. `frontmatter=true`
   shows the YAML block so you can verify your fields.
5. **Inspect the output** — is the noise gone, the body complete, the frontmatter
   fields present and correct? Iterate: edit → restart → re-convert.

**Run the sidecars while iterating.** `TRAFILATURA_URL` / `PLAYWRIGHT_URL` can
point at locally running sidecar containers (e.g. the published
`aeternalabshq/pullmd-trafilatura` and `aeternalabshq/pullmd-playwright`
images). A missing or unreachable sidecar changes which extractor wins the
quality auto-pick — and therefore what your recipe appears to do — so test
against the same sidecar setup production runs with.

**Transient near-empty output?** Bot-protected sites can intermittently serve a
near-empty rendered shell (frontmatter `quality: 0`, a body that is little more
than "skip to main content"). A retry with `nocache=1` usually resolves it —
retry before concluding your recipe is broken.

**Recipe seems to do nothing?** Check how the page was actually extracted: look
at the `X-Source` response header (or the `source:` field in the frontmatter,
with `frontmatter=true`). Recipes only apply when it reads `readability`,
`readability-fallback`, `trafilatura`, or `playwright`. Any other value —
`cloudflare`, `reddit`, `hackernews`, `youtube`, `markitdown`, `pdf-ocr`,
`image-caption`, `audio-transcript` — means the request never reached the
recipe layer for the reasons in [§1](#1-when-you-need-a-recipe); your recipe
cannot apply there, no matter how it's written.

**Capturing the rendered DOM.** When your recipe forces a render, your selectors
and JSON-LD paths must match the *rendered* HTML, not the raw response. To see
what the browser produced, convert once with the render forced and read the
Markdown, or use your browser's devtools "inspect" on the live page (which shows
the post-JavaScript DOM) to pick selectors. Raw `view-source:` shows only the
pre-JS HTML and will mislead you on rendered sites.

**Extracting JSON-LD to find paths.** Open the live page's devtools console and
run something like:

```js
[...document.querySelectorAll('script[type="application/ld+json"]')]
  .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
```

Inspect the objects, find the one whose `@type` you want, and read off the
dot-path to the value (remembering the array-first rule: an array step resolves
to its first element).

### Automated tests

Recipe tests live in `test/recipes-*.test.js` and `test/jsonld.test.js`, with
fixtures under `test/fixtures/recipes/`. Run the whole suite with:

```bash
node --test
```

Run a single file while iterating:

```bash
node --test test/recipes-frontmatter.test.js
```

A contributed recipe that exercises non-trivial behavior (frontmatter
extraction, JSON-LD paths, unusual matching) **should ship with a test**. The
cleanest model to copy is `test/recipes-frontmatter.test.js`: it feeds HTML to
`extractHtml(html, { url, recipes })`, builds the frontmatter with
`buildFrontmatter`, and asserts the fields. Because `extractHtml` accepts a
`recipes` array directly, you can test a recipe without touching the shipped
file. For pure matching/merge behavior, `test/recipes-matcher.test.js` and
`test/recipes-actions.test.js` are simpler models.

---

## 11. Contributing checklist

Before opening a PR that adds a built-in recipe:

- [ ] The recipe is a valid entry in `site-recipes.default.json` (loads with zero
      rejections — verify via `GET /api/recipes/status`).
- [ ] `name` is unique and descriptive; `host`/`path` are as narrow as the fix
      needs (don't match more URLs than necessary).
- [ ] One concern per recipe where practical (split unrelated fixes; they merge).
- [ ] A test accompanies the recipe when it exercises non-trivial behavior
      (mirror `test/recipes-frontmatter.test.js`). `node --test` passes.
- [ ] A one-line note in `CHANGELOG.md` under the current unreleased section.
- [ ] This guide is left untouched unless your change alters recipe *semantics*
      (new field, new action, changed matching) — in which case update it here too.
