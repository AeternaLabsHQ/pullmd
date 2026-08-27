"""Client-Hints metadata derived from the User-Agent we claim to be.

Chromium emits `Sec-CH-UA` itself, from the *browser's own* identity, and
`new_context(user_agent=...)` does not touch it. So a request goes out with a
User-Agent saying "Chrome/147 on Windows" and, one header down, a Sec-CH-UA
saying `"HeadlessChrome";v="131"`. Bot rules read that second header: swapping
only the brand token, with everything else identical, is the difference
between 403 and 200 on an Akamai-protected host.

These helpers turn the UA string we actually send into the Client-Hints
metadata a real browser would send alongside it, so the two agree.
"""
import re

# GREASE entry. Real Chrome randomises the label and its position; a fixed
# plausible one is enough - what gets matched on is the presence of a real
# browser brand, not the decoy.
GREASE_BRAND = "Not_A Brand"
GREASE_VERSION = "24"


def chrome_version(user_agent: str) -> str | None:
    """Full Chrome version from a UA string, or None if it is not Chrome-like.

    Matches Chrome and HeadlessChrome; deliberately not Safari or Firefox,
    which send no Client Hints at all.
    """
    m = re.search(r"(?:Headless)?Chrome/(\d+(?:\.\d+)*)", user_agent or "")
    return m.group(1) if m else None


def platform_for(user_agent: str) -> tuple[str, str]:
    """(platform, platformVersion) as Client Hints spell them."""
    ua = user_agent or ""
    if "Android" in ua:
        return "Android", "13.0.0"
    if "Windows NT" in ua:
        return "Windows", "10.0.0"
    if "Mac OS X" in ua or "Macintosh" in ua:
        return "macOS", "14.0.0"
    if "CrOS" in ua:
        return "Chrome OS", "14541.0.0"
    return "Linux", ""


def build_ua_metadata(user_agent: str, mobile: bool = False) -> dict | None:
    """Client-Hints metadata matching `user_agent`, or None when it is not
    a Chromium-based UA (Safari and friends send no Sec-CH-UA - for those the
    caller has to strip the header instead of rewriting it)."""
    full_version = chrome_version(user_agent)
    if full_version is None:
        return None

    major = full_version.split(".")[0]
    platform, platform_version = platform_for(user_agent)
    is_mobile = mobile or "Mobile" in (user_agent or "") or "Android" in (user_agent or "")

    return {
        "brands": [
            {"brand": GREASE_BRAND, "version": GREASE_VERSION},
            {"brand": "Chromium", "version": major},
            {"brand": "Google Chrome", "version": major},
        ],
        "fullVersion": full_version,
        "platform": platform,
        "platformVersion": platform_version,
        "architecture": "" if is_mobile else "x86",
        "model": "",
        "mobile": is_mobile,
    }
