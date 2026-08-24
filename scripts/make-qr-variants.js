import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

// Makes N byte-distinct copies of a QR image, so the same payment QR does not land on 900
// phones as one identical file.
//
// Why this matters more than the message wording: WhatsApp identifies media by the hash of
// the file. Nine hundred people receiving nine hundred copies of the SAME hash is a single,
// unambiguous fingerprint of a broadcast — far louder than nine hundred copies of similar
// text, which is what the message variants already break up. Ten hashes shared by ninety
// people each is a different shape entirely.
//
// How: a JPEG is a chain of marker segments, and COM (0xFFFE) is the one that exists purely
// to hold a comment nobody renders. Inserting one right after SOI changes every byte offset
// after it and therefore the file hash, while the compressed image data is copied verbatim —
// so the QR is pixel-for-pixel the original and scans exactly the same. No image library, no
// re-encoding, nothing to get subtly wrong at 90 rupees a scan.
//
// ponytail: metadata-only variation. It works because Baileys uploads the bytes it is given.
// If WhatsApp ever re-encodes on upload, every variant would converge back to one hash — the
// upgrade then is real pixel variation (a 1-3px quiet-zone margin difference, regenerated
// from the UPI string with the `qrcode` dependency this repo already has).

const SOI = 0xd8;
const COM = 0xfe;

// Buffer with a COM segment carrying `text` spliced in directly after the SOI marker.
export function withJpegComment(buf, text) {
  if (buf[0] !== 0xff || buf[1] !== SOI) throw new Error('not a JPEG (no SOI marker)');
  const body = Buffer.from(text, 'latin1');
  // Segment length counts the two length bytes themselves, hence +2. A JPEG segment cannot
  // exceed 65533 bytes of payload; the comments here are ~40 bytes, but guard anyway.
  if (body.length + 2 > 0xffff) throw new Error('comment too long for one COM segment');
  const header = Buffer.from([0xff, COM, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([buf.subarray(0, 2), header, body, buf.subarray(2)]);
}

const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

function main() {
  const [src, countArg] = process.argv.slice(2);
  if (!src) {
    console.error('Usage: node scripts/make-qr-variants.js <path/to/qr.jpg> [count=6]');
    console.error('Writes qr-1.jpg … qr-N.jpg beside the source, then prints the config line.');
    process.exit(1);
  }
  const count = Number(countArg) || 6;
  const dir = path.dirname(src);
  const original = fs.readFileSync(src);

  console.log(`source ${src} — ${original.length} bytes, sha ${sha(original)}\n`);
  const names = [];
  for (let i = 1; i <= count; i++) {
    // The comment text only has to differ per variant. Random padding of a random length so
    // the files differ in SIZE too, not just in content at one fixed offset.
    const pad = crypto.randomBytes(8 + Math.floor(Math.random() * 24)).toString('hex');
    const out = withJpegComment(original, `qr-${i}-${pad}`);
    const name = `qr-${i}.jpg`;
    fs.writeFileSync(path.join(dir, name), out);
    names.push(`./${name}`);
    console.log(`  ${name.padEnd(10)} ${String(out.length).padStart(7)} bytes  sha ${sha(out)}`);
  }

  console.log(`\nPut this in ${path.join(dir, 'config.json')}:\n`);
  console.log(`  "upiQrPath": ${JSON.stringify(names)}`);
  console.log('\nOpen two of them and scan both before you ship it.');
}

// Importable for the test, runnable for the operator. pathToFileURL rather than string
// concatenation: on Windows a bare `file://` + "C:\..." never matches import.meta.url's
// "file:///C:/...", and the script silently does nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
