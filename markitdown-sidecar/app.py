"""MarkItDown HTTP sidecar for PullMD: converts document bytes to Markdown."""
import io
from urllib.parse import unquote

from fastapi import FastAPI, Request, HTTPException
from markitdown import MarkItDown, StreamInfo

app = FastAPI(title="markitdown-sidecar")

# Plugins disabled: only the vetted built-in converters run.
md = MarkItDown(enable_plugins=False)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/convert")
async def convert(request: Request):
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")

    filename = request.headers.get("x-filename")
    if filename:
        try:
            filename = unquote(filename)
        except Exception:
            pass

    content_type = request.headers.get("content-type")
    mimetype = content_type.split(";")[0].strip() if content_type else None

    stream_info = StreamInfo(mimetype=mimetype, filename=filename)
    try:
        result = md.convert_stream(io.BytesIO(body), stream_info=stream_info)
    except Exception as e:  # noqa: BLE001 - surface any converter failure as 422
        raise HTTPException(status_code=422, detail=f"conversion failed: {e}")

    return {
        "markdown": result.text_content or "",
        "title": getattr(result, "title", None),
    }
