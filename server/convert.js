/*
 * MOBI / AZW3 -> EPUB conversion.
 *
 * The image used to install Calibre for this, which cost ~700MB of Qt and
 * Python for 52 books. KindleUnpack (vendored under vendor/kindleunpack) does
 * the same unpacking in ~350KB of pure Python, so the image stays small and
 * the container no longer spawns a Qt process per book.
 *
 * KindleUnpack writes an .epub for KF8 (AZW3) books, but for Mobipocket 7 it
 * leaves a loose html + content.opf directory. That case is zipped into an
 * EPUB here so the reader always gets one file.
 *
 * Converted files are cached in DATA_DIR/converted so a book is only
 * converted once (or again when the source file changes).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KUP_DIR = path.join(ROOT, 'vendor', 'kindleunpack');
const KUP_ENTRY = path.join(KUP_DIR, 'lib', 'kindleunpack.py');

function pythonBin() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

/* Availability now means "the vendored unpacker is in the image", not "a
 * package manager installed something at build time". */
function isAvailable() {
  return fs.existsSync(KUP_ENTRY);
}

// One conversion per book at a time: a double click used to start two
// processes writing the same output file.
const inFlight = new Map();

function readableError(err) {
  if (err && err.code === 'ENOENT') {
    return '容器里缺少 python3，无法解包 Kindle 格式（镜像应在构建时安装 python3）';
  }
  if (err && err.killed) {
    return '转换超时（超过 5 分钟），这本书可能太大或带有 DRM 保护';
  }
  const raw = String((err && (err.stderr || err.message)) || err || '').replace(/\s+/g, ' ').trim();
  return '转换失败：' + (raw ? raw.slice(-300) : '未知原因');
}

async function walk(dir, base = dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function findEpub(dir) {
  const files = await walk(dir);
  // A combination file yields both mobi7/ and mobi8/; the KF8 copy is the
  // better rendering, so prefer a path containing mobi8.
  const epub = files.filter(f => /\.epub$/i.test(f));
  if (!epub.length) return '';
  return epub.find(f => /mobi8\//i.test(f)) || epub[0];
}

async function findOpf(dir) {
  const files = await walk(dir);
  const opf = files.filter(f => /\.opf$/i.test(f));
  if (!opf.length) return '';
  return opf.find(f => /mobi7\//i.test(f)) || opf[0];
}

const CONTAINER_XML = (opf) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
  '  <rootfiles>\n' +
  '    <rootfile full-path="' + opf + '" media-type="application/oebps-package+xml"/>\n' +
  '  </rootfiles>\n' +
  '</container>\n';

/* Zip a loose unpacked book back into a spec-shaped EPUB: mimetype first and
 * stored uncompressed, container.xml pointing at the OPF, everything else
 * deflated. jszip preserves insertion order, which is what makes the
 * mimetype-first rule hold. */
async function packAsEpub(rootDir, opfRel, outFile) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML(opfRel));

  const files = await walk(rootDir);
  for (const rel of files) {
    if (rel === 'mimetype' || rel === 'META-INF/container.xml') continue;
    const data = await fsp.readFile(path.join(rootDir, rel));
    zip.file(rel, data, { binary: true });
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await fsp.writeFile(outFile, buf);
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
        ' 格式，需要内置解包器才能在线阅读。镜像里的 vendor/kindleunpack 缺失。'
    };
  }

  const tmp = outFile + '.' + process.pid + '.part.epub';
  // KindleUnpack takes a directory and writes a tree into it; a scratch dir
  // keeps the converted cache clean and is removed either way.
  const work = path.join(cfg.convertDir, '.work-' + book.id + '-' + process.pid);
  try {
    await fsp.mkdir(cfg.convertDir, { recursive: true });
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
  } catch (e) {
    return { ok: false, error: '无法创建转换目录：' + e.message };
  }

  const cleanup = async () => {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
  };

  const run = () => new Promise(resolve => {
    execFile(
      pythonBin(),
      [KUP_ENTRY, src, work],
      { timeout: 300000, maxBuffer: 8 * 1024 * 1024, cwd: KUP_DIR },
      err => resolve(err)
    );
  });

  const err = await run();
  // KindleUnpack talks a lot on success and on failure it still exits 0 in
  // some cases, so the output tree - not the exit code - decides.
  try {
    const epubRel = await findEpub(work);
    if (epubRel) {
      await fsp.copyFile(path.join(work, epubRel), tmp);
    } else {
      const opfRel = await findOpf(work);
      if (!opfRel) {
        await cleanup();
        return { ok: false, error: readableError(err) };
      }
      const rootDir = path.dirname(path.join(work, opfRel));
      const opfName = path.basename(opfRel);
      await packAsEpub(rootDir, opfName, tmp);
    }

    const st = await fsp.stat(tmp);
    if (!st.size) {
      await cleanup();
      return { ok: false, error: '转换出来的文件是空的，源文件可能已损坏' };
    }
    await fsp.rename(tmp, outFile);
  } catch (e) {
    await cleanup();
    return { ok: false, error: '转换结果写入失败：' + e.message };
  }

  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  return { ok: true, file: outFile, cached: false };
}

async function ensureEpub(book, cfg) {
  if (inFlight.has(book.id)) return inFlight.get(book.id);
  const job = convert(book, cfg).finally(() => inFlight.delete(book.id));
  inFlight.set(book.id, job);
  return job;
}

module.exports = { ensureEpub, isAvailable, pythonBin };
