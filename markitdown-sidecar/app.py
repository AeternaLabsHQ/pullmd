"""MarkItDown HTTP sidecar for PullMD: documents → Markdown.

Optional media tier (opt-in, env-gated), per-modality OpenAI-compatible:
  - Vision (image captions): MARKITDOWN_VISION_* (fallback MARKITDOWN_LLM_*)
  - Speech-to-text (audio):  MARKITDOWN_STT_*    (fallback MARKITDOWN_LLM_*)

Each backend is an OpenAI-compatible base_url — point it at a cloud provider
or a fully-local server (faster-whisper-server, LocalAI, Ollama, ...). We do
NOT use markitdown's built-in audio path (it silently calls Google).

Without credentials: images → EXIF metadata only, audio → metadata only,
no third-party calls.
"""
import io
import os
from urllib.parse import unquote

from fastapi import FastAPI, Request, HTTPException
from markitdown import MarkItDown, StreamInfo

MAX_BODY_BYTES = 50 * 1024 * 1024  # 50 MB
WHISPER_MAX_BYTES = 25 * 1024 * 1024  # OpenAI transcription hard limit


def _env(*names, default=None):
    """First non-empty env var among names, else default."""
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


VISION_API_KEY = _env("MARKITDOWN_VISION_API_KEY", "MARKITDOWN_LLM_API_KEY")
VISION_BASE_URL = _env("MARKITDOWN_VISION_BASE_URL", "MARKITDOWN_LLM_BASE_URL")
VISION_MODEL = _env("MARKITDOWN_VISION_MODEL", "MARKITDOWN_LLM_MODEL", default="gpt-4o-mini")

STT_API_KEY = _env("MARKITDOWN_STT_API_KEY", "MARKITDOWN_LLM_API_KEY")
STT_BASE_URL = _env("MARKITDOWN_STT_BASE_URL", "MARKITDOWN_LLM_BASE_URL")
STT_MODEL = _env("MARKITDOWN_STT_MODEL", "MARKITDOWN_TRANSCRIBE_MODEL", default="whisper-1")

app = FastAPI(title="markitdown-sidecar")


def _make_client(base_url, api_key):
    if not api_key:
        return None
    from openai import OpenAI
    return OpenAI(base_url=base_url, api_key=api_key) if base_url else OpenAI(api_key=api_key)


_vision_client = _make_client(VISION_BASE_URL, VISION_API_KEY)
_stt_client = _make_client(STT_BASE_URL, STT_API_KEY)

if _vision_client:
    md = MarkItDown(enable_plugins=False, llm_client=_vision_client, llm_model=VISION_MODEL)
else:
    md = MarkItDown(enable_plugins=False)

AUDIO_EXT = {"mp3", "wav", "m4a", "ogg", "flac", "aac", "webm", "mpga", "mpeg"}


def _is_audio(mimetype, filename):
    if mimetype and mimetype.startswith("audio/"):
        return True
    if filename and "." in filename:
        return filename.rsplit(".", 1)[-1].lower() in AUDIO_EXT
    return False


@app.get("/health")
def health():
    return {"ok": True, "vision": _vision_client is not None, "stt": _stt_client is not None}


@app.post("/convert")
async def convert(request: Request):
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="file too large (max 50 MB)")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="file too large (max 50 MB)")

    filename = request.headers.get("x-filename")
    if filename:
        filename = unquote(filename)

    content_type = request.headers.get("content-type")
    mimetype = content_type.split(";")[0].strip() if content_type else None

    # Audio → OpenAI-compatible transcription (only when STT is configured).
    if _is_audio(mimetype, filename) and _stt_client:
        if len(body) > WHISPER_MAX_BYTES:
            raise HTTPException(status_code=413, detail="audio too large for transcription (max 25 MB)")
        try:
            audio_name = filename or "audio.mp3"
            tr = _stt_client.audio.transcriptions.create(
                model=STT_MODEL,
                file=(audio_name, io.BytesIO(body)),
            )
            text = (getattr(tr, "text", "") or "").strip()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="transcription failed") from e
        return {
            "markdown": f"### Audio Transcript\n\n{text}" if text else "",
            "title": filename or "Audio",
        }

    # Everything else (incl. images when vision is set) → markitdown.
    stream_info = StreamInfo(mimetype=mimetype, filename=filename)
    try:
        result = md.convert_stream(io.BytesIO(body), stream_info=stream_info)
    except Exception as e:  # noqa: BLE001 - surface any converter failure as 422
        raise HTTPException(status_code=422, detail=f"conversion failed: {e}") from e

    return {
        "markdown": result.text_content or "",
        "title": getattr(result, "title", None),
    }
