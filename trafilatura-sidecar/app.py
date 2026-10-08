"""Trafilatura HTTP sidecar for PullMD."""
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
import trafilatura

app = FastAPI(title="trafilatura-sidecar")


class ExtractRequest(BaseModel):
    html: str


@app.get("/health")
def health():
    return {"ok": True, "trafilatura": trafilatura.__version__}


def to_markdown(html: str) -> str:
    result = trafilatura.extract(
        html,
        output_format="markdown",
        include_comments=False,
        include_tables=True,
        include_links=True,
        include_images=True,
        favor_recall=True,
    )
    return result or ""


@app.post("/extract", response_class=PlainTextResponse)
def extract(req: ExtractRequest):
    if not req.html:
        raise HTTPException(status_code=400, detail="html field required")
    return to_markdown(req.html)
