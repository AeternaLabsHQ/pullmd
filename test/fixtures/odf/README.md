# OpenDocument fixtures

Small invented documents for `test/opendocument.test.js`. No real personal data.

- `folien.odp` - LibreOffice Impress 24.2 output: a hand-written flat `.fodp`
  (three slides: title + nested list + speaker notes, title + link, a slide
  without title frame and with an empty placeholder) converted with
  `soffice --headless --convert-to odp folien.fodp`. LibreOffice split the
  nested list into two sibling lists on the way, which the test relies on.
- `bericht.odt` and `ernte.ods` - LibreOffice Writer and Calc were not
  installed on the machine that made these, so they are hand-written ODF
  packages: `content.xml`, `styles.xml`, `meta.xml` and
  `META-INF/manifest.xml` written by hand, zipped with Python's `zipfile`
  with the `mimetype` entry first and stored, the rest deflated.
  `bericht.odt` covers headings, a table of contents, bold/italic automatic
  styles, a named character style, a link, a footnote, an annotation,
  bullet and numbered lists, and a table. `ernte.ods` mimics Calc's
  real output with `number-columns-repeated="16384"` /
  `number-rows-repeated="1048571"` filler, a merged cell, an empty sheet
  and a second sheet.

To inspect or change one: `unzip` it, edit the XML, and zip it again with
`mimetype` first and uncompressed.

## Real LibreOffice Writer/Calc output

- `lo-writer.odt` - `../rtf/quartalsbericht.html` converted by LibreOffice
  25.8 Writer, `lo-calc.ods` - a semicolon CSV (`Monat;Kilo;Notiz`, two rows)
  converted by Calc. Both made in a throwaway container, because the host has
  no Writer/Calc:

  ```bash
  docker run --rm -v "$PWD":/w -w /w alpine:latest sh -c \
    "apk add --no-cache libreoffice-writer libreoffice-calc font-dejavu && \
     soffice --headless --infilter='HTML (StarWriter)' --convert-to odt quartalsbericht.html && \
     soffice --headless --infilter='CSV:59,34,76' --convert-to ods ernte.csv"
  ```
