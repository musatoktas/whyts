import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTypeDescriptors } from '../src/types.js';

function fixture(t, content) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-types-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'types.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test('descriptor streaming handles tiny UTF-8 chunks, escaped quotes and nested arrays', async t => {
  const selected = { id: 2, display: 'Türkçe 😀 {[] } \\"quoted\\"', flags: ['Object'],
    firstDeclaration: { path: '/a/日本語.ts', start: { line: 3, character: 1 } }, unionTypes: [3, 4] };
  for (const spacing of [undefined, 2]) {
    const file = fixture(t, JSON.stringify([{ id: 1 }, selected, { id: 3 }], null, spacing));
    const result = await readTypeDescriptors(file, new Set([2]), { chunkBytes: 1 });
    assert.deepEqual(result.descriptors, [selected]);
    assert.equal(result.stats.resolvedIds, 1);
    assert.equal(result.stats.selectionComplete, true);
    assert.equal(result.stats.recordsScanned, 2);
    assert.deepEqual(result.warnings, []);
  }
});

test('files larger than 128 MiB resolve selected IDs without reading or retaining the whole file', async t => {
  const record = { id: 42, symbolName: 'Selected' };
  const file = fixture(t, '[' + JSON.stringify(record));
  const descriptor = fs.openSync(file, 'r+');
  // A sparse tail makes the file large without allocating a giant test buffer.
  fs.writeSync(descriptor, Buffer.from(']'), 0, 1, 129 * 1024 * 1024);
  fs.closeSync(descriptor);
  const result = await readTypeDescriptors(file, [42]);
  assert.ok(result.stats.fileBytes > 128 * 1024 * 1024);
  assert.deepEqual(result.descriptors, [record]);
  assert.ok(result.stats.scannedBytes <= 64 * 1024);
  assert.equal(result.stats.retainedBytes, Buffer.byteLength(JSON.stringify(record)));
  assert.deepEqual(result.warnings, []);
});

test('missing IDs and missing or malformed files leave explicit warnings and preserve resolved descriptors', async t => {
  const missing = await readTypeDescriptors(fixture(t), [4]);
  assert.deepEqual(missing.descriptors, []);
  assert.match(missing.warnings.join('\n'), /missing/);
  const absent = await readTypeDescriptors(fixture(t, '[{"id":1}]'), [2]);
  assert.equal(absent.stats.selectionComplete, false);
  assert.match(absent.warnings.join('\n'), /1 of 1.*not resolved/);
  for (const content of ['[{"id":1},{"id":', '[{"id":1},]', '[{"id":1}]garbage']) {
    const malformed = await readTypeDescriptors(fixture(t, content), [1, 2], { chunkBytes: 3 });
    assert.deepEqual(malformed.descriptors, [{ id: 1 }]);
    assert.equal(malformed.stats.resolvedIds, 1);
    assert.match(malformed.warnings.join('\n'), /invalid JSON/);
  }
});

test('record, retention and scan budgets bound work while exposing unresolved IDs', async t => {
  const records = [{ id: 1, display: 'x'.repeat(100) }, { id: 2 }, { id: 3 }];
  const file = fixture(t, JSON.stringify(records));
  const recordLimited = await readTypeDescriptors(file, [1, 2], { maxRecordBytes: 30, chunkBytes: 5 });
  assert.deepEqual(recordLimited.descriptors, [{ id: 2 }]);
  assert.equal(recordLimited.stats.skippedRecords, 1);
  assert.match(recordLimited.warnings.join('\n'), /limits/);
  const retained = await readTypeDescriptors(file, [2, 3], { maxRetainedBytes: 8 });
  assert.deepEqual(retained.descriptors, [{ id: 2 }]);
  assert.equal(retained.stats.retainedBytes, 8);
  assert.equal(retained.stats.selectionComplete, false);
  assert.match(retained.warnings.join('\n'), /not resolved/);
  const scanned = await readTypeDescriptors(file, [3], { maxScanBytes: 32, chunkBytes: 8 });
  assert.deepEqual(scanned.descriptors, []);
  assert.ok(scanned.stats.scannedBytes <= 40);
  assert.match(scanned.warnings.join('\n'), /scan stopped/);
});
