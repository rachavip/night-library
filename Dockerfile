FROM node:20-bookworm-slim

# Two small CLI tools instead of one enormous one:
#   python3         runs the vendored KindleUnpack (MOBI / AZW3 -> EPUB)
#   poppler-utils   supplies pdftoppm, which renders page one of a scanned PDF
#                   as its cover - those files carry no embedded cover at all
#
# Calibre used to provide both the conversion and the metadata scraping, and
# pulled in Qt6 + WebEngine: ~700MB of the image for 52 Kindle books. The
# metadata reading is now plain JS (server/mobi.js, server/library.js) and the
# conversion is KindleUnpack under vendor/, so the whole layer is ~30MB.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

ENV TZ=Asia/Shanghai \
    BOOKS_DIR=/app/demo-books \
    DATA_DIR=/app/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json* ./
# pdf.js lists `canvas` as an optional Node-only dependency; it is not needed
# because rendering happens in the browser, and compiling it in a slim image
# would require extra native build packages.
#
# --ignore-scripts is required here: package.json has a postinstall hook that
# runs scripts/prepare-vendor.js, but scripts/ is not copied into the image
# until the next step. Run that hook explicitly after COPY . . below.
RUN npm install --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund

COPY . .

# `prepare-vendor` copies the browser bundles out of node_modules, so the npm
# packages themselves are dead weight afterwards: pdfjs-dist is 32MB for two
# files, epubjs 6.6MB for one. Dropping them costs nothing at runtime - the
# server never requires them.
#
# vendor/kindleunpack ships as one zip so the repo can be updated by dragging
# a single file into GitHub; it is unpacked (and removed) here. jszip is kept
# because server/convert.js zips loose MOBI7 trees back into EPUBs.
RUN node scripts/prepare-vendor.js \
 && rm -rf node_modules/pdfjs-dist node_modules/epubjs \
 && if [ -f vendor/kindleunpack.zip ]; then \
      python3 -c "import zipfile; zipfile.ZipFile('vendor/kindleunpack.zip').extractall('vendor/kindleunpack')" \
      && rm -f vendor/kindleunpack.zip; \
    fi

VOLUME ["/app/data"]
EXPOSE 8080

CMD ["node", "server/index.js"]
