"""Standalone tests for YouTube transcript fetching + classification.

No pytest / youtube_transcript_api / markitdown dependency — run directly:
    python3 test_youtube.py
Exits non-zero on the first failed assertion.
"""
from yt_transcript import fetch_snippets, _format_transcript


# --- fake youtube_transcript_api exceptions (classified by class __name__) ---
class IpBlocked(Exception):
    pass


class RequestBlocked(Exception):
    pass


class TranscriptsDisabled(Exception):
    pass


class NoTranscriptFound(Exception):
    pass


class _Snippet:
    def __init__(self, start, text):
        self.start = start
        self.text = text


class _Transcript:
    def __init__(self, snippets=None, lang="en", exc=None):
        self._snippets = snippets or []
        self.language_code = lang
        self._exc = exc

    def fetch(self):
        if self._exc:
            raise self._exc
        return self._snippets


class _FakeApi:
    """Configurable stand-in for YouTubeTranscriptApi."""

    def __init__(self, transcripts=None, list_exc=None, fetch_result=None, fetch_exc=None):
        self._transcripts = transcripts if transcripts is not None else []
        self._list_exc = list_exc
        self._fetch_result = fetch_result
        self._fetch_exc = fetch_exc

    def list(self, video_id):
        if self._list_exc:
            raise self._list_exc
        return list(self._transcripts)

    def fetch(self, video_id, languages=None):
        if self._fetch_exc:
            raise self._fetch_exc
        return self._fetch_result or []


def test_ok_returns_snippets_via_list_loop():
    t = _Transcript(snippets=[_Snippet(0.0, "hello"), _Snippet(2.0, "world")], lang="de")
    snippets, status = fetch_snippets(_FakeApi(transcripts=[t]), "vid", [])
    assert status == "ok", status
    assert snippets == [(0.0, "hello"), (2.0, "world")], snippets


def test_list_loop_fetch_429_is_blocked_not_none():
    # transcript EXISTS (list works) but the content fetch is rate-limited (429)
    t = _Transcript(exc=IpBlocked("429"), lang="de")
    snippets, status = fetch_snippets(_FakeApi(transcripts=[t]), "vid", [])
    assert snippets == [], snippets
    assert status == "blocked", status


def test_list_call_blocked_is_blocked():
    _, status = fetch_snippets(_FakeApi(list_exc=RequestBlocked("blocked")), "vid", [])
    assert status == "blocked", status


def test_transcripts_disabled_is_none():
    _, status = fetch_snippets(_FakeApi(list_exc=TranscriptsDisabled("no captions")), "vid", [])
    assert status == "none", status


def test_empty_list_is_none():
    _, status = fetch_snippets(_FakeApi(transcripts=[]), "vid", [])
    assert status == "none", status


def test_preferred_lang_ok():
    api = _FakeApi(fetch_result=[_Snippet(1.0, "x")])
    snippets, status = fetch_snippets(api, "vid", ["en"])
    assert status == "ok", status
    assert snippets == [(1.0, "x")], snippets


def test_preferred_lang_block_short_circuits():
    _, status = fetch_snippets(_FakeApi(fetch_exc=IpBlocked("429")), "vid", ["en"])
    assert status == "blocked", status


def test_preferred_lang_miss_falls_through_to_list():
    # requested 'en' not directly available, but German exists in the list -> ok
    t = _Transcript(snippets=[_Snippet(0.0, "hallo")], lang="de")
    api = _FakeApi(transcripts=[t], fetch_exc=NoTranscriptFound("no en"))
    snippets, status = fetch_snippets(api, "vid", ["en"])
    assert status == "ok", status
    assert snippets == [(0.0, "hallo")], snippets


def test_format_transcript_none_timecodes_per_snippet():
    out = _format_transcript([(0.0, "a"), (65.0, "b")], "vid", "none", 0)
    assert out == "a\n\nb", out


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok - {t.__name__}")
    print(f"\n{len(tests)} passed")
