FROM python:3.12-slim

LABEL org.opencontainers.image.title="PullMD MarkItDown sidecar"
LABEL org.opencontainers.image.description="MarkItDown document-to-Markdown converter sidecar for PullMD."
LABEL org.opencontainers.image.source="https://github.com/AeternaLabsHQ/pullmd"
LABEL org.opencontainers.image.url="https://github.com/AeternaLabsHQ/pullmd"
LABEL org.opencontainers.image.documentation="https://github.com/AeternaLabsHQ/pullmd#readme"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.vendor="Aeterna Labs"

RUN useradd --create-home --shell /bin/bash app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py limits.py .

USER app
EXPOSE 8003

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8003"]
