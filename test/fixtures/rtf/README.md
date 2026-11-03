RTF fixtures (invented, neutral content).

- `quartalsbericht.html` - source document (headings, bold/italic, link,
  bullet and numbered list, table with a `|` in a cell, umlauts, the euro sign).
- `quartalsbericht.rtf` - `quartalsbericht.html` converted by LibreOffice
  25.8.7.3 (Writer). The host has no `libreoffice-writer` package, so the
  conversion ran in a throwaway Alpine container:

  ```bash
  docker run --rm -v "$PWD":/w -w /w alpine:latest sh -c \
    "apk add --no-cache libreoffice-writer font-dejavu && \
     soffice --headless --infilter='HTML (StarWriter)' \
       --convert-to 'rtf:Rich Text Format' --outdir /w /w/quartalsbericht.html"
  ```

  Without `--infilter` LibreOffice opens the HTML as Writer/Web, which has no
  RTF export filter.

Encapsulated-HTML (`\fromhtml1`) samples come from the compressed RTF bodies
of the `.msg` fixtures in `../msg/` and from the [MS-OXRTFEX] section 3.1
example, inlined in `test/rtf.test.js`.
