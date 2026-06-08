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
from urllib.parse import unquote, urlparse, parse_qs

import bs4  # markitdown core dependency (beautifulsoup4)

from fastapi import FastAPI, Request, HTTPException
from markitdown import MarkItDown, StreamInfo

MAX_BODY_BYTES = 50 * 1024 * 1024  # 50 MB
WHISPER_MAX_BYTES = 25 * 1024 * 1024  # OpenAI transcription hard limit

YT_LANGS = [s.strip() for s in os.environ.get("MARKITDOWN_YT_LANGS", "").split(",") if s.strip()]
YT_PROXY = os.environ.get("MARKITDOWN_YT_PROXY")
YT_TIMECODES_DEFAULT = (os.environ.get("MARKITDOWN_YT_TIMECODES", "links") or "links").lower()
try:
    YT_CHUNK_DEFAULT = int(os.environ.get("MARKITDOWN_YT_CHUNK", "30"))
except ValueError:
    YT_CHUNK_DEFAULT = 30


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


def _yt_video_id(url):
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if host == "youtu.be":
            return parsed.path.lstrip("/").split("/")[0] or None
        parts = parsed.path.split("/")
        if parsed.path.startswith("/shorts/") and len(parts) > 2:
            return parts[2] or None
        return parse_qs(parsed.query).get("v", [None])[0]
    except Exception:
        return None


def _yt_api():
    from youtube_transcript_api import YouTubeTranscriptApi
    if YT_PROXY:
        from youtube_transcript_api.proxies import GenericProxyConfig
        return YouTubeTranscriptApi(proxy_config=GenericProxyConfig(http_url=YT_PROXY, https_url=YT_PROXY))
    return YouTubeTranscriptApi()


def _fetch_snippets(video_id):
    """List of (start_seconds, text). [] on any failure (never raises)."""
    try:
        api = _yt_api()

        def to_list(ft):
            return [(float(s.start), s.text) for s in ft]

        if YT_LANGS:
            try:
                return to_list(api.fetch(video_id, languages=YT_LANGS))
            except Exception:
                pass
        for t in api.list(video_id):
            try:
                return to_list(t.fetch())
            except Exception:
                continue
    except Exception:
        pass
    return []


def _fmt_ts(seconds):
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _format_transcript(snippets, video_id, timecodes, chunk):
    if not snippets:
        return ""
    blocks = []
    if chunk <= 0:
        blocks = list(snippets)
    else:
        start, texts = None, []
        for st, tx in snippets:
            if start is not None and st - start >= chunk:
                blocks.append((start, " ".join(texts)))
                start, texts = None, []
            if start is None:
                start = st
            texts.append(tx)
        if texts:
            blocks.append((start or 0, " ".join(texts)))

    lines = []
    for st, tx in blocks:
        tx = " ".join(tx.split())
        if not tx:
            continue
        if timecodes == "none":
            lines.append(tx)
        elif timecodes == "plain":
            lines.append(f"[{_fmt_ts(st)}] {tx}")
        else:  # links
            lines.append(f"[{_fmt_ts(st)}](https://www.youtube.com/watch?v={video_id}&t={int(st)}s) {tx}")
    return "\n\n".join(lines)


def _yt_metadata(body):
    """Best-effort title/description/channel/duration/views/published from HTML."""
    out = {"title": None, "description": None, "channel": None,
           "duration": None, "views": None, "published": None}
    if not body:
        return out
    try:
        soup = bs4.BeautifulSoup(body, "html.parser")

        def meta(attr, val, key="content"):
            el = soup.find("meta", attrs={attr: val})
            return el.get(key).strip() if el and el.get(key) else None

        out["title"] = meta("property", "og:title") or (soup.title.string.strip() if soup.title and soup.title.string else None)
        out["description"] = meta("property", "og:description")
        out["duration"] = meta("itemprop", "duration")
        out["views"] = meta("itemprop", "interactionCount")
        out["published"] = meta("itemprop", "datePublished") or meta("itemprop", "uploadDate")
        author = soup.find("span", attrs={"itemprop": "author"})
        if author:
            link = author.find("link", attrs={"itemprop": "name"})
            if link and link.get("content"):
                out["channel"] = link["content"].strip()
    except Exception:
        pass
    return out


def _humanize_iso_duration(iso):
    """PT#H#M#S → H:MM:SS / MM:SS. Returns the input unchanged if unparseable."""
    if not iso or not iso.startswith("PT"):
        return iso
    import re as _re
    m = _re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
    if not m:
        return iso
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return f"{h}:{mi:02d}:{s:02d}" if h else f"{mi:02d}:{s:02d}"


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


@app.post("/youtube")
async def youtube(request: Request):
    body = await request.body()
    source_url = request.headers.get("x-source-url") or ""
    video_id = _yt_video_id(source_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="missing/invalid YouTube watch URL in X-Source-Url")

    timecodes = (request.headers.get("x-yt-timecodes") or YT_TIMECODES_DEFAULT).lower()
    if timecodes not in ("links", "plain", "none"):
        timecodes = "links"
    try:
        chunk = int(request.headers.get("x-yt-chunk") or YT_CHUNK_DEFAULT)
    except ValueError:
        chunk = YT_CHUNK_DEFAULT

    meta = _yt_metadata(body)
    snippets = _fetch_snippets(video_id)
    transcript = _format_transcript(snippets, video_id, timecodes, chunk)

    markdown_body = ""
    if meta["description"]:
        markdown_body += f"## Description\n\n{meta['description']}\n\n"
    markdown_body += f"## Transcript\n\n{transcript}\n" if transcript else "## Transcript\n\n_No transcript available._\n"

    return {
        "markdown": markdown_body.strip(),
        "title": meta["title"] or "YouTube video",
        "fields": {
            "channel": meta["channel"],
            "duration": _humanize_iso_duration(meta["duration"]),
            "views": meta["views"],
            "published": meta["published"],
        },
    }
