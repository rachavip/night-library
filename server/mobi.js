/*
 * A small MOBI / AZW3 reader.
 *
 * The shelf only needs four things from a Kindle file: title, author,
 * language and the cover picture. Calibre's `ebook-meta` did that job, but it
 * dragged ~700MB of Qt and Python into the image for 52 books. The Palm
 * database header and the MOBI header are both fixed layouts, so reading them
 * directly costs a few hundred lines instead of a quarter of the image.
 *
 * Layout references: MOBI header fields at the offsets used by KindleUnpack
 * (lib/mobi_header.py), EXTH records per the Mobipocket spec.
 */
const fs = require('fs');
const fsp = fs.promises;

const PDB_HEADER = 78;
const RECORD_ENTRY = 8;

// EXTH record ids that matter here.
const EXTH_AUTHOR = 100;
const EXTH_CDETYPE = 501;
const EXTH_TITLE = 503;
const EXTH_LANGUAGE = 524;
const EXTH_COVER_OFFSET = 201;
const EXTH_THUMB_OFFSET = 202;

// Windows LCIDs that show up in Chinese libraries. A language_code outside
// this map is left empty rather than guessed - the shelf falls back to a
// neutral label, which beats claiming an English book is Chinese.
const LCID = {
  0x0804: 'zh', 0x0404: 'zh', 0x0c04: 'zh', 0x1004: 'zh', 0x1404: 'zh',
  0x0409: 'en', 0x0809: 'en', 0x0c09: 'en', 0x0411: 'ja', 0x0412: 'ko',
  0x0407: 'de', 0x040c: 'fr', 0x0410: 'it', 0x040a: 'es', 0x0419: 'ru'
};

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/* Read the record table from the Palm database header. Each record is a
 * 4-byte offset, so a record's size is simply the next offset minus its own. */
function parseRecordTable(head, numRecords) {
  const offsets = [];
  for (let i = 0; i <= numRecords; i++) {
    const at = PDB_HEADER + i * RECORD_ENTRY;
    if (at + 4 > head.length) break;
    offsets.push(head.readUInt32BE(at));
  }
  return offsets;
}

function decodeText(buf, encoding) {
  if (!buf || !buf.length) return '';
  if (encoding === 65001) return buf.toString('utf8');
  // 1252 and 932 and friends: latin1 keeps the bytes intact, and the EXTH
  // records we prefer are UTF-8 anyway. This path only feeds a fallback title.
  return buf.toString('latin1');
}

/* EXTH is a chain of (id, size, data) records sitting right after the MOBI
 * header. `size` counts the 8-byte header, which is easy to get wrong. */
function parseExth(buf) {
  const out = {};
  if (!buf || buf.length < 12 || buf.toString('latin1', 0, 4) !== 'EXTH') return out;
  const count = buf.readUInt32BE(8);
  let pos = 12;
  for (let i = 0; i < count && pos + 8 <= buf.length; i++) {
    const id = buf.readUInt32BE(pos);
    const size = buf.readUInt32BE(pos + 4);
    if (size < 8) break;
    const data = buf.subarray(pos + 8, Math.min(pos + size, buf.length));
    // Duplicates exist in the wild; the first occurrence is the one readers use.
    if (out[id] === undefined) out[id] = data;
    pos += size;
  }
  return out;
}

function imageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/*
 * Returns { title, author, language, coverExt, cover } for a MOBI/AZW3 file.
 * Every field is optional: a file that fails to parse yields {} and the
 * caller falls back to scraping the filename.
 */
async function readMeta(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const stat = await fh.stat();

    const head = await readAt(fh, 0, Math.min(stat.size, PDB_HEADER + RECORD_ENTRY * 64));
    if (head.length < PDB_HEADER) return {};
    const ident = head.toString('latin1', 60, 68);
    if (ident !== 'BOOKMOBI' && ident !== 'TEXtREAd') return {};

    const numRecords = head.readUInt16BE(76);
    if (!numRecords) return {};
    // The table is 8 bytes per record plus one trailing offset; fetch it whole
    // so cover lookups do not need a second round trip.
    const tableLen = PDB_HEADER + RECORD_ENTRY * (numRecords + 1);
    const table = tableLen <= head.length ? head : await readAt(fh, 0, tableLen);
    const offsets = parseRecordTable(table, numRecords);
    if (offsets.length < 2 || !offsets[0]) return {};

    // Record 0 holds the PalmDOC header (16 bytes) followed by the MOBI header.
    const rec0 = await readAt(fh, offsets[0], Math.min(offsets[1] - offsets[0], 1024 * 128));
    if (rec0.length < 32 || rec0.toString('latin1', 16, 20) !== 'MOBI') return {};

    // MOBI header fields are addressed from the start of record 0, not from
    // the 'MOBI' magic at byte 16 - reading them relative to the magic shifts
    // every field by 16 and yields a title of raw bytes. Confirmed against
    // KindleUnpack's own dump of a real file: title_offset 0x54, first image
    // record 0x6c, exth flags 0x80, all absolute in record 0.
    const headerLength = rec0.readUInt32BE(0x14);
    const encoding = rec0.readUInt32BE(0x1c);
    const titleOffset = rec0.readUInt32BE(0x54);
    const titleLength = rec0.readUInt32BE(0x58);
    const languageCode = rec0.readUInt32BE(0x5c);
    const firstImage = rec0.readUInt32BE(0x6c);
    const exthFlags = rec0.readUInt32BE(0x80);

    // Full name lives inside record 0, right after the MOBI header block. A
    // zero offset means the file never set one; the Palm database name is the
    // only name available then (and is usually the original filename).
    let title = '';
    if (titleLength > 0 && titleOffset > 0 && titleOffset + titleLength <= rec0.length) {
      title = decodeText(rec0.subarray(titleOffset, titleOffset + titleLength), encoding).replace(/\0+$/, '').trim();
    }
    if (!title) {
      const raw = table.subarray(0, 32).toString('latin1');
      title = raw.split('\0')[0].replace(/[_]+/g, ' ').trim();
    }

    const meta = {};
    if (title) meta.title = title;

    // Some hand-built files leave the EXTH flag clear yet still ship an EXTH
    // block, so trust the magic byte over the flag.
    const exthStart = 16 + headerLength;
    {
      if (exthStart + 12 <= rec0.length) {
        const exth = parseExth(rec0.subarray(exthStart));
        const titleTag = exth[EXTH_TITLE];
        if (titleTag && titleTag.length) {
          const t = decodeText(titleTag, 65001).replace(/\0+$/, '').trim();
          if (t) meta.title = t;
        }
        const authorTag = exth[EXTH_AUTHOR];
        if (authorTag && authorTag.length) {
          const a = decodeText(authorTag, 65001).replace(/\0+$/, '').trim();
          if (a) meta.author = a;
        }
        const langTag = exth[EXTH_LANGUAGE];
        if (langTag && langTag.length) {
          const l = decodeText(langTag, 65001).replace(/\0+$/, '').trim();
          if (l) meta.language = l.slice(0, 12);
        }
        // 201/202 are byte offsets relative to the first image record.
        for (const key of [EXTH_COVER_OFFSET, EXTH_THUMB_OFFSET]) {
          const tag = exth[key];
          if (!tag || tag.length !== 4) continue;
          const index = firstImage + tag.readUInt32BE(0);
          if (index <= 0 || index >= offsets.length - 1) continue;
          const start = offsets[index];
          const end = offsets[index + 1];
          if (!start || end <= start || end - start > 24 * 1024 * 1024) continue;
          const img = await readAt(fh, start, end - start);
          const ext = imageExt(img);
          // A declared cover that is not actually an image is common in
          // hand-built files; keep looking instead of storing junk.
          if (ext) {
            meta.coverExt = ext;
            meta.cover = img;
            break;
          }
        }
      }
    }

    if (!meta.language && LCID[languageCode]) meta.language = LCID[languageCode];
    return meta;
  } catch (e) {
    return {};
  } finally {
    if (fh) fh.close().catch(() => {});
  }
}

module.exports = { readMeta, imageExt };
