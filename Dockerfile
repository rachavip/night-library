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

# prepare-vendor 把浏览器用的 bundle 从 node_modules 拷出来；obfuscate 把
# server/ 与 public/js/ 就地换成混淆版本，让镜像里的代码难以阅读。
# 混淆器只在构建时用：安装、混淆、prune 放在同一个 RUN 里，
# 这样它和它的依赖不会残留到镜像层，体积不受影响（仓库里保存的仍是可读源码）。
#
# `prepare-vendor` 之后 pdfjs-dist（32MB 只用两个文件）和 epubjs（6.6MB 只用一个）
# 就没用了，删掉省体积；jszip 保留，server/convert.js 用它把 MOBI7 散装目录压成 EPUB。
# vendor/kindleunpack 以单个 zip 分发，这里解压后删除。
RUN npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund \
      javascript-obfuscator@5 \
 && node scripts/prepare-vendor.js \
 && node scripts/obfuscate.js \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/pdfjs-dist node_modules/epubjs \
 && if [ -f vendor/kindleunpack.zip ]; then \
      python3 -c "import zipfile; zipfile.ZipFile('vendor/kindleunpack.zip').extractall('vendor/kindleunpack')" \
      && rm -f vendor/kindleunpack.zip; \
    fi

VOLUME ["/app/data"]
EXPOSE 8080

CMD ["node", "server/index.js"]
