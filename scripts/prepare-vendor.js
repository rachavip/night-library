/*
 * Copy the browser-side reader libraries out of node_modules into public/vendor
 * so the served app is fully self-contained (no CDN, works offline on a NAS).
 * Runs automatically on `npm install` via postinstall.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'public', 'vendor');
fs.mkdirSync(dest, { recursive: true });

const copies = [
  ['node_modules/pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
  // epub.js does not bundle its zip reader: without a global JSZip it throws
  // "JSZip lib not loaded" and every EPUB / converted MOBI fails to open.
  ['node_modules/jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['node_modules/epubjs/dist/epub.min.js', 'epub.min.js']
];

for (const [src, name] of copies) {
  const from = path.join(root, src);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(dest, name));
    console.log('[vendor] ready:', name);
  } else {
    console.warn('[vendor] missing (run npm install):', src);
  }
}

/* server/transform.js reads the text layer of a PDF in Node, which needs the
 * legacy build plus its worker (pdf.js runs the worker in-process there). That
 * lives one level up in vendor/pdfjs - not under public/, since it is a server
 * dependency and there is no reason to serve it. */
const legacyDest = path.join(root, 'vendor', 'pdfjs');
fs.mkdirSync(legacyDest, { recursive: true });
for (const name of ['pdf.js', 'pdf.worker.js']) {
  const from = path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', name);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(legacyDest, name));
    console.log('[vendor] ready: vendor/pdfjs/' + name);
  } else {
    console.warn('[vendor] missing (run npm install): legacy/build/' + name);
  }
}
