"""Standalone tests for the Client-Hints metadata helpers.

No pytest / playwright dependency — run directly:  python3 test_ua_metadata.py
Exits non-zero on the first failed assertion.
"""
from ua_metadata import build_ua_metadata, chrome_version, platform_for

CHROME_WIN = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
HEADLESS_LINUX = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) HeadlessChrome/131.0.6778.33 Safari/537.36")
IPHONE_SAFARI = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                 "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
ANDROID_CHROME = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")


def test_chrome_version_extracted():
    assert chrome_version(CHROME_WIN) == "147.0.0.0"
    assert chrome_version(ANDROID_CHROME) == "131.0.0.0"


def test_headless_chrome_is_still_chrome_like():
    # We must recognise it precisely because this is the UA we have to fix up.
    assert chrome_version(HEADLESS_LINUX) == "131.0.6778.33"


def test_non_chromium_has_no_version():
    assert chrome_version(IPHONE_SAFARI) is None
    assert chrome_version("") is None
    assert chrome_version("Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/130.0") is None


def test_platform_follows_the_ua():
    assert platform_for(CHROME_WIN) == ("Windows", "10.0.0")
    assert platform_for(HEADLESS_LINUX)[0] == "Linux"
    assert platform_for(ANDROID_CHROME)[0] == "Android"
    assert platform_for("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")[0] == "macOS"


def test_metadata_never_says_headless():
    # The whole point: no brand may carry the automation token.
    meta = build_ua_metadata(HEADLESS_LINUX)
    brands = [b["brand"] for b in meta["brands"]]
    assert "HeadlessChrome" not in brands, brands
    assert "Google Chrome" in brands
    assert "Chromium" in brands


def test_brand_version_matches_the_ua_version():
    meta = build_ua_metadata(CHROME_WIN)
    for b in meta["brands"]:
        if b["brand"] in ("Chromium", "Google Chrome"):
            assert b["version"] == "147", b
    assert meta["fullVersion"] == "147.0.0.0"


def test_platform_matches_the_ua_platform():
    # A Windows UA with a Linux platform hint is the same contradiction we set
    # out to remove, just one field over.
    meta = build_ua_metadata(CHROME_WIN)
    assert meta["platform"] == "Windows"
    assert meta["mobile"] is False
    assert meta["architecture"] == "x86"


def test_mobile_flag_from_ua_and_from_caller():
    assert build_ua_metadata(ANDROID_CHROME)["mobile"] is True
    assert build_ua_metadata(ANDROID_CHROME)["architecture"] == ""
    assert build_ua_metadata(CHROME_WIN, mobile=True)["mobile"] is True


def test_non_chromium_ua_gets_no_metadata():
    # Safari sends no Sec-CH-UA at all; inventing one would be a new tell.
    assert build_ua_metadata(IPHONE_SAFARI) is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok - {t.__name__}")
    print(f"\n{len(tests)} passed")
