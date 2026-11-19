// Last middleware of the app. Anything that reaches next(err) leaves as JSON
// { error, code }. Express' default handler would answer an HTML page with the
// stack trace and absolute paths unless NODE_ENV=production.
export function finalErrorHandler(err, req, res, next) {
  // The response has started: the only safe move is to let Express close it.
  if (res.headersSent) return next(err);

  // body-parser limit violations. /api/html names its 10 MB cap and /api/file
  // its 25 MB cap; other routes (e.g. /mcp at 1 MB) get the generic message.
  if (err?.type === 'entity.too.large') {
    let error = 'Request body too large. / Anfrage zu groß.';
    if (req.path === '/api/html') error = 'File too large (max 10 MB). / Datei zu groß (max. 10 MB).';
    else if (req.path === '/api/file') error = 'File too large (max 25 MB). / Datei zu groß (max. 25 MB).';
    return res.status(413).json({ error, code: 'payload_too_large' });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid request body. / Ungültiger Anfrage-Body.',
      code: 'invalid_body',
    });
  }

  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    return res.status(status).json({
      error: 'Bad request. / Ungültige Anfrage.',
      code: 'bad_request',
    });
  }

  console.error(`Unhandled error on ${req.method} ${req.path}:`, err?.stack ?? err);
  return res.status(500).json({
    error: 'Internal server error. / Interner Serverfehler.',
    code: 'internal_error',
  });
}
