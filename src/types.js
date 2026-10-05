import fs from 'node:fs';

const MiB = 1024 * 1024;

// Parse one descriptor at a time. The total types.json size is not a memory limit.
// Only IDs selected from this same trace are retained; no whole-file JSON.parse.
export async function readTypeDescriptors(file, ids, options = {}) {
  const wanted = new Set(ids), descriptors = [], warnings = [];
  const maxRecordBytes = options.maxRecordBytes ?? 4 * MiB;
  const maxRetainedBytes = options.maxRetainedBytes ?? 16 * MiB;
  const maxScanBytes = options.maxScanBytes ?? 1024 * MiB;
  const stats = { mode: 'selective-stream', fileBytes: null, scannedBytes: 0, retainedBytes: 0,
    requestedIds: wanted.size, resolvedIds: 0, recordsScanned: 0, skippedRecords: 0, selectionComplete: wanted.size === 0 };
  let stream;
  try {
    stats.fileBytes = fs.statSync(file).size;
    if (!wanted.size) return { descriptors, stats, warnings };
    stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: options.chunkBytes ?? 64 * 1024 });
    let mode = 'start', depth = 0, quoted = false, escaped = false;
    let parts = [], recordBytes = 0, skipping = false, finished = false;
    const append = text => {
      if (skipping || !text) return;
      recordBytes += Buffer.byteLength(text);
      if (recordBytes > maxRecordBytes) { skipping = true; parts = []; }
      else parts.push(text);
    };
    scan: for await (const chunk of stream) {
      stats.scannedBytes += Buffer.byteLength(chunk);
      if (stats.scannedBytes > maxScanBytes) {
        warnings.push(`Type descriptor scan stopped at ${maxScanBytes} bytes (file: ${stats.fileBytes} bytes); unresolved IDs remain explicit.`);
        break;
      }
      let segment = mode === 'record' ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];
        if (mode === 'record') {
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === '{' || char === '[') depth++;
          else if (char === '}' || char === ']') depth--;
          if (depth === 0) {
            append(chunk.slice(segment, i + 1)); segment = -1;
            stats.recordsScanned++;
            if (skipping) stats.skippedRecords++;
            else {
              const record = JSON.parse(parts.join(''));
              if (wanted.has(record.id)) {
                if (stats.retainedBytes + recordBytes <= maxRetainedBytes) {
                  descriptors.push(record); wanted.delete(record.id); stats.retainedBytes += recordBytes;
                } else stats.skippedRecords++;
              }
            }
            parts = []; recordBytes = 0; skipping = false; mode = 'separator';
            if (!wanted.size) { stats.selectionComplete = true; break scan; }
          }
        } else if (/\s/.test(char)) continue;
        else if (mode === 'start' && char === '[') mode = 'entry-or-end';
        else if ((mode === 'entry' || mode === 'entry-or-end') && char === '{') {
          mode = 'record'; depth = 1; quoted = false; escaped = false; segment = i;
        } else if ((mode === 'separator' || mode === 'entry-or-end') && char === ']') { mode = 'done'; finished = true; }
        else if (mode === 'separator' && char === ',') mode = 'entry';
        else throw new Error('Malformed descriptor array');
      }
      if (mode === 'record' && segment >= 0) append(chunk.slice(segment));
    }
    if (!stats.selectionComplete && stats.scannedBytes <= maxScanBytes && !finished) throw new Error('Incomplete descriptor array');
    if (stats.skippedRecords) warnings.push(`${stats.skippedRecords} type descriptors exceeded the per-record or retained-data limits (${maxRecordBytes}/${maxRetainedBytes} bytes); unresolved IDs remain explicit.`);
    if (wanted.size) warnings.push(`${wanted.size} of ${stats.requestedIds} selected type IDs were not resolved from types.json (${stats.fileBytes} bytes).`);
  } catch (error) {
    warnings.push(error.code === 'ENOENT'
      ? 'types.json is missing; type IDs remain available.'
      : `Type descriptor reading failed (${error.code ?? 'invalid JSON'}; file: ${stats.fileBytes ?? 'unknown'} bytes); unresolved IDs remain explicit.`);
  } finally {
    // Early selection destroys the iterator, but closing its file handle is asynchronous.
    // Wait before callers remove the trace directory, especially on Windows/Node 20.
    if (stream && !stream.closed) await new Promise(resolve => {
      stream.once('close', resolve); stream.destroy();
    });
  }
  stats.resolvedIds = descriptors.length;
  return { descriptors, stats, warnings };
}
