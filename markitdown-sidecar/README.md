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

Image captioning and audio transcription are **not** enabled here.

## Optional media tier (opt-in)

Image captioning and audio transcription use **OpenAI-compatible** endpoints,
configurable independently per modality. Each falls back to a shared
`MARKITDOWN_LLM_*` set if the modality-specific vars are unset.

Vision (image captions):
- `MARKITDOWN_VISION_API_KEY`, `MARKITDOWN_VISION_BASE_URL`, `MARKITDOWN_VISION_MODEL` (default `gpt-4o-mini`)

Speech-to-text (audio):
- `MARKITDOWN_STT_API_KEY`, `MARKITDOWN_STT_BASE_URL`, `MARKITDOWN_STT_MODEL` (default `whisper-1`)

Shared fallback:
- `MARKITDOWN_LLM_API_KEY`, `MARKITDOWN_LLM_BASE_URL`, `MARKITDOWN_LLM_MODEL`, `MARKITDOWN_TRANSCRIBE_MODEL`

Point a `*_BASE_URL` at a local server (faster-whisper-server, LocalAI, Ollama)
to keep all data on-host. Without an API key: images → EXIF only, audio →
metadata only, no third-party calls. `GET /health` reports `vision`/`stt` booleans.
