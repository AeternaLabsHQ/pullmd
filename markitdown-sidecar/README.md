# PullMD MarkItDown sidecar

Converts document **bytes** (PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, EPUB, ZIP,
CSV, JSON, XML) to Markdown via Microsoft's
[markitdown](https://github.com/microsoft/markitdown).

## API

- `GET  /health` → `{"ok": true}`
- `POST /convert` — raw file bytes in the body. Optional headers:
  - `Content-Type`: original mimetype (used as a converter hint)
  - `X-Filename`: URI-encoded original file name (extension hint)

  Returns `{"markdown": "...", "title": "..."|null}`. Converter failures → 422.

## Run

```bash
uvicorn app:app --host 0.0.0.0 --port 8003
```

Image captioning and audio transcription are handled by the pullmd Node app (`PULLMD_VISION_*`, `PULLMD_STT_*`, `PULLMD_LLM_*` — see the main README), not this sidecar.

## YouTube (opt-in, no API key)

`POST /youtube` — page HTML in the body, watch URL in `X-Source-Url`. Returns
`{markdown, title, fields}` (channel/duration/views/published). Transcript via
`youtube-transcript-api`; degrades to metadata-only when unavailable.

Per-request headers (override env defaults):
- `X-YT-Timecodes` — `links` (clickable, default) | `plain` | `none`
- `X-YT-Chunk` — block size in seconds; `0` = per original snippet

Env defaults: `MARKITDOWN_YT_TIMECODES`, `MARKITDOWN_YT_CHUNK`,
`MARKITDOWN_YT_LANGS` (e.g. `de,en`; falls back to first available),
`MARKITDOWN_YT_PROXY` (datacenter IPs are often blocked).
