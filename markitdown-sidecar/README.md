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
