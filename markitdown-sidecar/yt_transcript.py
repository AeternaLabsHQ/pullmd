"""YouTube transcript fetching, classification and formatting.

Kept dependency-free (stdlib only) so it is unit-testable without the heavy
markitdown/fastapi/youtube_transcript_api stack — the API client is injected.

`fetch_snippets` distinguishes *why* a transcript is empty so the caller can tell
an honest story instead of always claiming "no transcript available":

    ok      -> snippets were retrieved
    none    -> the video genuinely has no (accessible) transcript
    blocked -> a transcript EXISTS but YouTube rate-limited the fetch (HTTP 429)
    error   -> some other failure while fetching
"""

# Exception class names (matched by __name__ to stay version-resilient) that mean
# "YouTube rate-limited / blocked us" — youtube_transcript_api raises these on 429.
_BLOCK_NAMES = {"IpBlocked", "RequestBlocked"}

# Names that mean the video genuinely has no retrievable transcript.
_NONE_NAMES = {
    "TranscriptsDisabled",
    "NoTranscriptFound",
    "VideoUnavailable",
    "AgeRestricted",
    "VideoUnplayable",
    "InvalidVideoId",
}


def _is_block(exc):
    """True if the exception represents a YouTube rate-limit / block (HTTP 429)."""
    if type(exc).__name__ in _BLOCK_NAMES:
        return True
    # YouTubeRequestFailed wraps the raw HTTPError; sniff for a 429 in its text.
    return "429" in str(exc)


def _classify_other(exc):
    return "none" if type(exc).__name__ in _NONE_NAMES else "error"


def fetch_snippets(api, video_id, yt_langs):
    """Return (list_of_(start_seconds, text), status). Never raises.

    `api` is a ready youtube_transcript_api client (injected for testability).
    `yt_langs` is the preferred language list (may be empty).
    """
    def to_list(ft):
        return [(float(s.start), s.text) for s in ft]

    try:
        # Preferred languages first, if configured.
        if yt_langs:
            try:
                return to_list(api.fetch(video_id, languages=yt_langs)), "ok"
            except Exception as e:
                if _is_block(e):
                    return [], "blocked"
                # otherwise fall through to listing every available transcript

        try:
            transcripts = list(api.list(video_id))
        except Exception as e:
            return [], ("blocked" if _is_block(e) else _classify_other(e))

        if not transcripts:
            return [], "none"

        blocked = False
        for t in transcripts:
            try:
                return to_list(t.fetch()), "ok"
            except Exception as e:
                if _is_block(e):
                    blocked = True
                # try the next listed transcript
        # The list call worked (so a transcript exists) but no fetch succeeded.
        return [], ("blocked" if blocked else "error")
    except Exception:
        return [], "error"


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
