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
