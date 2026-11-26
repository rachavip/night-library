/*
 * MOBI / AZW3 -> EPUB conversion via Calibre's ebook-convert.
 * Converted files are cached in DATA_DIR/converted so a book is only
 * converted once (or again when the source file changes).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

// The Calibre CLI is `ebook-convert`, not `ebook-converter`. The misspelled
// name made every MOBI / AZW3 open fail with ENOENT even on images where
// Calibre was installed correctly.
function converterBin() {
  return process.env.CALIBRE_PATH || 'ebook-convert';
}

function isAvailable() {
  return process.platform !== 'win32' || Boolean(process.env.CALIBRE_PATH);
}

// One conversion per book at a time: a double click used to start two Calibre
// processes writing the same output file.
const inFlight = new Map();

function readableError(err, bin) {
  if (err && err.code === 'ENOENT') {
    return '容器里没有找到 ' + bin + ' 命令，镜像可能没有装上 Calibre';
  }
  if (err && err.killed) {
    return '转换超时（超过 5 分钟），这本书可能太大或带有 DRM 保护';
  }
  const raw = String((err && (err.stderr || err.message)) || err || '').replace(/\s+/g, ' ').trim();
  return '转换失败：' + (raw ? raw.slice(-300) : '未知原因');
}

async function convert(book, cfg) {
  const outFile = path.join(cfg.convertDir, book.id + '.epub');
  const folder = book.folder || cfg.booksDir;
  const src = path.resolve(folder, book.path);
  if (!src.startsWith(path.resolve(folder) + path.sep)) {
    return { ok: false, error: '书籍路径无效' };
  }

  try {
    const [srcStat, outStat] = await Promise.all([fsp.stat(src), fsp.stat(outFile)]);
    if (outStat.size > 0 && outStat.mtimeMs >= srcStat.mtimeMs) {
      return { ok: true, file: outFile, cached: true };
    }
  } catch (e) { /* not cached yet */ }

  if (!isAvailable()) {
    return {
      ok: false,
      error: '这本是 ' + String(book.format || '').toUpperCase() +
        ' 格式，需要 Calibre 才能在线阅读。请在 Docker 镜像中安装 Calibre（默认已包含）。'
    };
  }

  const bin = converterBin();
  // Calibre picks the output format from the extension, so the temporary file
  // has to keep the .epub suffix; it is renamed only after a clean exit.
  const tmp = outFile + '.' + process.pid + '.part.epub';
  try {
    await fsp.mkdir(cfg.convertDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '无法创建转换目录：' + e.message };
  }

  return new Promise(resolve => {
    execFile(
      bin,
      [src, tmp, '--enable-heuristics'],
      { timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
      async err => {
        if (err) {
          try { await fsp.unlink(tmp); } catch (e) { /* ignore */ }
          return resolve({ ok: false, error: readableError(err, bin) });
        }
        try {
          const st = await fsp.stat(tmp);
          if (!st.size) {
            await fsp.unlink(tmp).catch(() => {});
            return resolve({ ok: false, error: '转换出来的文件是空的，源文件可能已损坏' });
          }
          await fsp.rename(tmp, outFile);
        } catch (e) {
          await fsp.unlink(tmp).catch(() => {});
          return resolve({ ok: false, error: '转换结果写入失败：' + e.message });
        }
        resolve({ ok: true, file: outFile, cached: false });
      }
    );
  });
}

async function ensureEpub(book, cfg) {
  if (inFlight.has(book.id)) return inFlight.get(book.id);
  const job = convert(book, cfg).finally(() => inFlight.delete(book.id));
  inFlight.set(book.id, job);
  return job;
}

module.exports = { ensureEpub, isAvailable, converterBin };
