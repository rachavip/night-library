FROM node:20-bookworm-slim

# Calibre supplies ebook-converter / ebook-meta so MOBI and AZW3 can be
# converted to EPUB for in-browser reading. Everything else is read natively.
RUN apt-get update && apt-get install -y --no-install-recommends \
      calibre \
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
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY . .

VOLUME ["/books", "/app/data"]
EXPOSE 8080

CMD ["node", "server/index.js"]
