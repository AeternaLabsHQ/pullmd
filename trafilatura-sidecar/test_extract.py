"""Standalone regression tests for the sidecar's Markdown output.

Needs trafilatura + fastapi, so run it inside the built image:
  docker build -t pullmd-trafilatura:dev trafilatura-sidecar
  docker run --rm -v "$PWD/trafilatura-sidecar/test_extract.py:/app/test_extract.py:ro" \\
    pullmd-trafilatura:dev python test_extract.py
Exits non-zero on the first failed assertion.
"""
from app import to_markdown

# trafilatura only keeps a block once the article reaches its minimum length.
FILLER = "This update adjusts how the preview pane handles files downloaded from the web and does more things here. " * 2


def test_inline_formatting_in_list_items_keeps_spaces():
    # Issue #60: trafilatura 2.0.0 dropped the space after </em> and </strong>
    # inside list items and glued the "- " marker onto the previous line.
    html = (
        f"<html><body><article><p>{FILLER}</p><ul>"
        f"<li><p><em>New!</em> This update {FILLER}</p></li>"
        f"<li>a new <strong>Preview anyway</strong> button {FILLER}</li>"
        f"</ul><p>{FILLER}</p></article></body></html>"
    )
    lines = to_markdown(html).splitlines()
    assert any(line.startswith("- *New!* This update") for line in lines), lines
    assert any(line.startswith("- a new **Preview anyway** button") for line in lines), lines


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok - {t.__name__}")
    print(f"\n{len(tests)} passed")
