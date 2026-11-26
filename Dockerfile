FROM node:20-bookworm-slim

# Calibre supplies ebook-meta so MOBI and AZW3 can be converted to EPUB for
# in-browser reading. poppler-utils supplies pdftoppm, which renders page one of
# a scanned PDF as its cover - those files carry no embedded cover at all.
# Everything else is read natively.
RUN apt-get update && apt-get install -y --no-install-recommends \
      calibre \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

ENV QT_QPA_PLATFORM=offscreen \
    TZ=Asia/Shanghai \
    BOOKS_DIR=/books \
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
RUN node scripts/prepare-vendor.js

VOLUME ["/books", "/app/data"]
EXPOSE 8080

CMD ["node", "server/index.js"]
