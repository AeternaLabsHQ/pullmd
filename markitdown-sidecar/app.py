"""MarkItDown HTTP sidecar for PullMD: documents → Markdown."""
import asyncio
import io
import os
from urllib.parse import unquote, urlparse, parse_qs

import bs4  # YouTube metadata parsing (declared explicitly in requirements.txt)

from fastapi import FastAPI, Request, HTTPException
from markitdown import MarkItDown, StreamInfo

from limits import run_guarded

MAX_BODY_BYTES = 50 * 1024 * 1024  # 50 MB

# Each conversion runs in a disposable child process so a decompression bomb or
# pathological document can't pin CPU or OOM the long-lived server. Timeout is
# the always-on guard; the memory cap is opt-in (RLIMIT_AS over-counts virtual
# memory, so a container mem_limit is the recommended hard bound).
CONVERT_TIMEOUT = float(os.environ.get("MARKITDOWN_CONVERT_TIMEOUT", "60") or 0)
CONVERT_MEM_MB = int(os.environ.get("MARKITDOWN_MEM_LIMIT_MB", "0") or 0)

YT_LANGS = [s.strip() for s in os.environ.get("MARKITDOWN_YT_LANGS", "").split(",") if s.strip()]
YT_PROXY = os.environ.get("MARKITDOWN_YT_PROXY")
YT_TIMECODES_DEFAULT = (os.environ.get("MARKITDOWN_YT_TIMECODES", "links") or "links").lower()
try:
    YT_CHUNK_DEFAULT = int(os.environ.get("MARKITDOWN_YT_CHUNK", "30"))
except ValueError:
    YT_CHUNK_DEFAULT = 30

app = FastAPI(title="markitdown-sidecar")

md = MarkItDown(enable_plugins=False)


def _convert_doc(body, mimetype, filename):
    """Top-level (picklable) conversion target run inside the guarded child."""
    result = md.convert_stream(io.BytesIO(body), stream_info=StreamInfo(mimetype=mimetype, filename=filename))
    return (result.text_content or "", getattr(result, "title", None))


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
    return {"ok": True}


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

    # Everything → markitdown document conversion, sandboxed in a child process
    # with a wall-clock timeout (+ optional memory cap) so a malicious document
    # can't pin CPU or OOM the server. The blocking wait runs off the event loop.
    try:
        markdown, title = await asyncio.to_thread(
            run_guarded, _convert_doc, (body, mimetype, filename),
            timeout=CONVERT_TIMEOUT, mem_mb=CONVERT_MEM_MB,
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="conversion timed out")
    except MemoryError:
        raise HTTPException(status_code=413, detail="conversion exceeded the memory limit")
    except RuntimeError as e:  # converter raised inside the child
        raise HTTPException(status_code=422, detail=f"conversion failed: {e}")

    return {"markdown": markdown, "title": title}


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
