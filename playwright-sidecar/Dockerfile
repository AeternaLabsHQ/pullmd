FROM mcr.microsoft.com/playwright/python:v1.49.0-noble

LABEL org.opencontainers.image.title="PullMD Playwright sidecar"
LABEL org.opencontainers.image.description="Headless Chromium renderer sidecar for PullMD — handles JavaScript-rendered pages."
LABEL org.opencontainers.image.source="https://github.com/AeternaLabsHQ/pullmd"
LABEL org.opencontainers.image.url="https://github.com/AeternaLabsHQ/pullmd"
LABEL org.opencontainers.image.documentation="https://github.com/AeternaLabsHQ/pullmd#readme"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.vendor="Aeterna Labs"

RUN useradd --create-home --shell /bin/bash app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ua_metadata.py .

USER app
EXPOSE 8002

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8002"]
