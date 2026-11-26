/*
 * MOBI / AZW3 -> EPUB conversion via Calibre's ebook-converter.
 * Converted files are cached in DATA_DIR/converted so a book is only
 * converted once (or again when the source file changes).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

function isAvailable() {
  return process.platform !== 'win32' || Boolean(process.env.CALIBRE_PATH);
}

function converterBin() {
  return process.env.CALIBRE_PATH || 'ebook-converter';
}

async function ensureEpub(book, cfg) {
  const outFile = path.join(cfg.convertDir, book.id + '.epub');
  const folder = book.folder || cfg.booksDir;
  const src = path.resolve(folder, book.path);
  if (!src.startsWith(path.resolve(folder) + path.sep)) {
    return { ok: false, error: '书籍路径无效' };
  }

  try {
    const [srcStat, outStat] = await Promise.all([fsp.stat(src), fsp.stat(outFile)]);
    if (outStat.size > 0 && outStat.mtimeMs >= srcStat.mtimeMs) return { ok: true, file: outFile, cached: true };
  } catch (e) { /* not cached yet */ }

  if (!isAvailable()) {
    return {
      ok: false,
      error: '这本是 ' + book.format.toUpperCase() + ' 格式，需要 Calibre 才能在线阅读。请在 Docker 镜像中安装 Calibre（默认已包含）。'
    };
  }

  return new Promise(resolve => {
    execFile(
      converterBin(),
      [src, outFile, '--enable-heuristics'],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
      async err => {
        if (err) {
          try { await fsp.unlink(outFile); } catch (e) { /* ignore */ }
          return resolve({ ok: false, error: '转换失败：' + String(err.message || err).slice(0, 200) });
        }
        resolve({ ok: true, file: outFile, cached: false });
      }
    );
  });
}

module.exports = { ensureEpub, isAvailable };
