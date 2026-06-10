---
name: pullmd
description: "Read any web page, document, or YouTube video as clean Markdown using PullMD. Use this skill whenever you need to fetch, read, extract, or summarize content from a URL — web articles, Reddit threads, PDF/Word/PowerPoint/Excel/EPUB documents, or YouTube transcripts. This includes when the user says 'read this page', 'what does this URL say', 'fetch this article', 'summarize this PDF', 'get the transcript of this video', or when you need web content as context for another task. Also use this when WebFetch fails or returns poor results — PullMD produces cleaner Markdown than raw HTML parsing. Do NOT use this for GitHub URLs (use gh CLI instead) or for API endpoints that return JSON."
---

# PullMD Integration

Read web pages, documents, and YouTube videos as clean, structured Markdown
via the self-hosted PullMD service. Falls back gracefully to WebFetch if
PullMD is unavailable.

## Why PullMD over WebFetch

PullMD routes each URL through the extraction path that fits it:

1. **Reddit** — auto-detected URLs go through Reddit's JSON API with full comment trees.
2. **Cloudflare** — sites that support `Accept: text/markdown` get native Markdown directly.
3. **Static HTML** — Mozilla Readability and Trafilatura run in parallel; the higher-quality output wins.
4. **Headless Chromium fallback** — when static extraction returns body-soup or low-quality output (typical for Next.js / SPA pages), the page is rendered in a real browser before extracting.
5. **Documents** — direct links to PDF, Word, PowerPoint, Excel, EPUB, ZIP, CSV, JSON, or XML files are converted to Markdown (requires the markitdown sidecar on the instance).
6. **YouTube** — video URLs return title, description, and the transcript with clickable timecodes (when enabled on the instance).
7. **Images & audio** — captioned / transcribed when the instance has a vision or STT provider configured; metadata-only otherwise.

The result is much cleaner than the raw HTML that WebFetch returns, and it
works on JavaScript-heavy sites and binary formats that WebFetch can't
handle at all.

## How to use

### Step 1: Fetch via PullMD

Use Bash to curl the PullMD API. This is preferred over WebFetch because it returns clean Markdown directly:

```bash
curl -s "__PULLMD_URL__/api?url=<URL>"
```

The response is `text/markdown` — ready to use as-is.

**Available parameters:**

| Param           | Default | Notes                                                                       |
| --------------- | ------- | --------------------------------------------------------------------------- |
| `url`           | —       | Required.                                                                   |
| `comments`      | `true`  | Include Reddit comments. Ignored for non-Reddit URLs.                       |
| `comment_depth` | `3`     | Reddit comment nesting depth (1–10).                                        |
| `comment_limit` | none    | Max top-level Reddit comments (Reddit returns ~200 without a cap).          |
| `frontmatter`   | `false` | Prepend YAML metadata (title, source, quality, share id, …).                |
| `format`        | `md`    | `text` strips Markdown; `json` returns a structured response with metadata. |
| `nocache`       | `false` | Bypass the 1-hour cache and refetch from source.                            |
| `render`        | auto    | `force` → always render via Playwright. `skip` → never render. Bypasses cache. |
| `extractor`     | auto    | Force `readability` / `trafilatura` / `playwright`, skipping the quality pick. Bypasses cache. |
| `pdf`           | —       | `ocr` → high-quality OCR conversion for PDFs (table-grade output; needs a server-side OCR key). Bypasses cache. |
| `yt_timecodes`  | `links` | YouTube transcripts: `links` (clickable timestamps), `plain` (`[MM:SS]`), `none`. |
| `yt_chunk`      | `30`    | YouTube transcript block size in seconds; `0` = per original snippet.       |
| `lang`          | `de`    | Language for the comments-section header (`de` or `en`).                    |

**Response headers worth checking:**

- `X-Source` — `reddit` · `cloudflare` · `readability` · `readability-fallback` · `trafilatura` · `playwright` · `markitdown` · `youtube` · `image-caption` · `audio-transcript` · `pdf-ocr`
- `X-Quality` — `0.0–1.0` extraction confidence (low values mean the static extraction was thin or noisy)
- `X-Share-Id` — 8-hex permalink, openable as `__PULLMD_URL__/s/<id>` (absent for `/api/html` — local conversions are never cached or shared)

**Example calls:**

```bash
# Read an article
curl -s "__PULLMD_URL__/api?url=https://example.com/article"

# Read a Reddit post with comments
curl -s "__PULLMD_URL__/api?url=https://reddit.com/r/node/comments/abc/title/&comments=true"

# Convert a PDF / Office document by URL
curl -s "__PULLMD_URL__/api?url=https://example.com/report.pdf"

# Table-heavy PDF via the OCR tier (if enabled on the instance)
curl -s "__PULLMD_URL__/api?url=https://example.com/report.pdf&pdf=ocr"

# YouTube transcript with clickable timecodes (if enabled on the instance)
curl -s "__PULLMD_URL__/api?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Get fresh (uncached) content
curl -s "__PULLMD_URL__/api?url=https://example.com/news&nocache=true"

# Force the Playwright fallback for a JS-rendered page that didn't trigger
# the auto-detection (or where you want to be sure)
curl -s "__PULLMD_URL__/api?url=https://mistral.ai/pricing&render=force"

# Convert a local HTML file you already have (never cached, no share link; X-Filename keeps the name out of access logs)
curl -s -X POST --data-binary @page.html -H 'Content-Type: text/html' -H 'X-Filename: page.html' "__PULLMD_URL__/api/html"

# Upload a local document (PDF/DOCX/…, max 25 MB)
curl -s -X POST --data-binary @report.pdf -H 'Content-Type: application/pdf' -H 'X-Filename: report.pdf' "__PULLMD_URL__/api/file"
```

### Step 2: Check if it worked

If curl returns valid Markdown (starts with `#` or contains readable text), use that content. The `X-Source` response header tells you which extraction method was used. If `X-Source: playwright`, the page needed JavaScript rendering — that's normal for SPAs (Next.js, React, Vue dashboards, …).

### Step 3: Fallback to WebFetch

If PullMD fails (network error, timeout, empty response), fall back to the built-in WebFetch tool:

```
WebFetch(url="<URL>", prompt="Extract the main content of this page")
```

This still works but produces noisier output since it processes raw HTML.
(For document and YouTube URLs there is no WebFetch equivalent — report the
failure instead.)

## Decision flow

```
Need to read a URL?
├── Is it a GitHub URL? → Use `gh` CLI instead
├── Is it a JSON API? → Use curl/fetch directly
└── Anything else (web page, PDF/Office doc, YouTube, image, audio):
    ├── Try: curl PullMD API
    │   ├── Success (got Markdown) → Use it
    │   └── Failed (error/timeout/empty) → Fallback below
    └── Fallback: WebFetch tool (web pages only)
```

## Tips

- PullMD caches results for 1 hour. Use `nocache=true` if you need the latest version. `render=force|skip`, `extractor=`, `pdf=ocr`, and explicit `yt_*` params also bypass the cache.
- For pages with important comments or discussions (forums, HN, Reddit), add `comments=true` to include the discussion below the post.
- For JS-rendered apps where the auto-fallback didn't fire (e.g. content lives in a tab the heuristic didn't reach), `render=force` re-extracts via headless Chromium.
- Reddit URLs are automatically detected (incl. `redd.it` short links and `/r/<sub>/s/<id>` share links) and use a specialized extraction pipeline that handles posts, comments, galleries, and videos.
- Add `frontmatter=true` when you want metadata: extraction source and quality always; for Reddit posts also subreddit, author, upvotes, and publish date; for media/YouTube/OCR results duration, image size, and LLM token usage (cost tracking).
- The `/api/history` endpoint shows recent conversions — useful for checking what's been fetched: `curl -s "__PULLMD_URL__/api/history?limit=5"`.
- Persistent share links: every successful conversion gets an 8-hex `share_id`. `GET __PULLMD_URL__/s/<id>` returns the cached markdown and re-fetches from source if older than one hour — useful as a stable URL that always returns fresh content.
