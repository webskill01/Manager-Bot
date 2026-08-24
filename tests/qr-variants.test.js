import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withJpegComment } from '../scripts/make-qr-variants.js';

// A minimal but structurally real JPEG: SOI, an APP0 segment, some payload, EOI. The comment
// is spliced between SOI and whatever follows, so this is enough to assert the invariant.
const jpeg = Buffer.from([
  0xff, 0xd8,                          // SOI
  0xff, 0xe0, 0x00, 0x04, 0x11, 0x22,  // APP0, length 4
  0xde, 0xad, 0xbe, 0xef,              // "image data"
  0xff, 0xd9,                          // EOI
]);

// The whole safety argument for this trick: the compressed image data is copied byte for
// byte, so the QR that scans today scans the same after rotation. Strip the segment back out
// and the original must return exactly — if this ever fails, somebody is being handed a QR
// that no longer decodes to the right UPI id.
test('a variant is the original with one segment inserted, and nothing else touched', () => {
  const out = withJpegComment(jpeg, 'qr-1-abc');
  const len = (out[4] << 8) | out[5];
  assert.equal(out[2], 0xff);
  assert.equal(out[3], 0xfe, 'not a COM marker');
  assert.equal(len, 'qr-1-abc'.length + 2, 'segment length must count its own two bytes');

  // SOI (2) + marker (2) + the segment's own `len` bytes is where the original resumes.
  const stripped = Buffer.concat([out.subarray(0, 2), out.subarray(4 + len)]);
  assert.deepEqual(stripped, jpeg, 'the image data was altered');
});

test('different comments give different bytes — the point of the exercise', () => {
  const hashes = new Set(['a', 'bb', 'ccc'].map(c => withJpegComment(jpeg, c).toString('hex')));
  assert.equal(hashes.size, 3);
});

test('a non-JPEG is refused rather than silently corrupted', () => {
  assert.throws(() => withJpegComment(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'x'), /not a JPEG/);
});
