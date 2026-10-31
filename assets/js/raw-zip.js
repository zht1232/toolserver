/*!
 * raw_zip_writer.js
 * Minimal, dependency-free ZIP writer (STORE method only) for browser batch export.
 *
 * Public API (global `RawZip`, also `module.exports` when present):
 *   RawZip.create(files [, options]) -> Promise<Blob>   // Blob.type === 'application/zip'
 *     files   : [{ name: string, data: Blob | ArrayBuffer | Uint8Array | string }, ...]
 *               (any ArrayBuffer view is accepted; strings are encoded as UTF-8)
 *     options : { date?: Date }  // fixed last-modified timestamp for every entry
 *
 *   RawZip.crc32(bytes: Uint8Array) -> number   // unsigned 32-bit CRC-32
 *   RawZip.VERSION -> string
 *
 * Format notes:
 *   - STORE (compression method 0): JPEG/PNG payloads are already compressed.
 *   - Filenames are encoded as UTF-8 and general purpose flag bit 11 (0x0800)
 *     is set on every local and central header record.
 *   - Plain 32-bit ZIP (no ZIP64): at most 65535 entries, each name at most
 *     65535 UTF-8 bytes, each entry and the whole archive below 4 GiB.
 *   - Empty input produces a valid 22-byte end-of-central-directory only zip.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  root.RawZip = api;
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis
    : typeof self !== 'undefined' ? self
      : typeof window !== 'undefined' ? window
        : this,
  function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Constants (ZIP appnote 6.3.x, all multi-byte fields little-endian) *
     * ------------------------------------------------------------------ */

    var SIG_LOCAL = 0x04034b50;   // "PK\3\4" local file header
    var SIG_CENTRAL = 0x02014b50; // "PK\1\2" central directory header
    var SIG_EOCD = 0x06054b50;    // "PK\5\6" end of central directory

    var VERSION_MADE_BY = 20;     // 2.0, host OS 0 (MS-DOS/FAT)
    var VERSION_NEEDED = 20;      // 2.0, enough for stored entries
    var METHOD_STORE = 0;
    var FLAG_UTF8 = 0x0800;       // general purpose bit 11: UTF-8 names

    var UINT16_MAX = 0xFFFF;
    var UINT32_MAX = 0xFFFFFFFF;

    var LOCAL_HEADER_SIZE = 30;
    var CENTRAL_HEADER_SIZE = 46;
    var EOCD_SIZE = 22;

    /* ------------------------------------------------------------------ *
     * CRC-32 (IEEE 802.3, polynomial 0xEDB88320), lazily built table     *
     * ------------------------------------------------------------------ */

    var crcTable = null;

    function getCrcTable() {
      if (crcTable) {
        return crcTable;
      }
      var table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
      }
      crcTable = table;
      return table;
    }

    function crc32(bytes) {
      var table = getCrcTable();
      var crc = 0xFFFFFFFF;
      for (var i = 0; i < bytes.length; i++) {
        crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /* ------------------------------------------------------------------ *
     * Filename / payload helpers                                         *
     * ------------------------------------------------------------------ */

    var textEncoder = null;

    // Encode a JS string as UTF-8 bytes. TextEncoder when available, with a
    // spec-compliant manual fallback (handles surrogate pairs and replaces
    // lone surrogates with U+FFFD).
    function utf8Encode(str) {
      if (typeof TextEncoder === 'function') {
        if (!textEncoder) {
          textEncoder = new TextEncoder();
        }
        return textEncoder.encode(str);
      }
      var out = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
          var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
          if (next >= 0xDC00 && next <= 0xDFFF) {
            c = 0x10000 + ((c - 0xD800) << 10) + (next - 0xDC00);
            i++;
          } else {
            c = 0xFFFD;
          }
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
          c = 0xFFFD;
        }
        if (c < 0x80) {
          out.push(c);
        } else if (c < 0x800) {
          out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
          out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        } else {
          out.push(
            0xF0 | (c >> 18),
            0x80 | ((c >> 12) & 0x3F),
            0x80 | ((c >> 6) & 0x3F),
            0x80 | (c & 0x3F)
          );
        }
      }
      return new Uint8Array(out);
    }

    function isBlobLike(data) {
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return true;
      }
      // Cross-realm / older-engine duck typing.
      return !!data &&
        typeof data === 'object' &&
        typeof data.size === 'number' &&
        typeof data.type === 'string' &&
        typeof data.slice === 'function';
    }

    function isArrayBuffer(data) {
      return Object.prototype.toString.call(data) === '[object ArrayBuffer]';
    }

    function blobToBytes(blob) {
      if (typeof blob.arrayBuffer === 'function') {
        return blob.arrayBuffer().then(function (buffer) {
          return new Uint8Array(buffer);
        });
      }
      return new Promise(function (resolve, reject) {
        if (typeof FileReader === 'undefined') {
          reject(new Error('RawZip: cannot read Blob data (no Blob.arrayBuffer or FileReader)'));
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          resolve(new Uint8Array(reader.result));
        };
        reader.onerror = function () {
          reject(reader.error || new Error('RawZip: failed to read Blob data'));
        };
        reader.readAsArrayBuffer(blob);
      });
    }

    // Normalize entry payloads to Uint8Array without copying typed-array views
    // (Blob construction below snapshots the bytes).
    function toBytes(data) {
      if (data == null) {
        return Promise.reject(new TypeError('RawZip: entry data is required (Blob, ArrayBuffer, Uint8Array or string)'));
      }
      if (typeof data === 'string') {
        return Promise.resolve(utf8Encode(data));
      }
      if (isBlobLike(data)) {
        return blobToBytes(data);
      }
      if (ArrayBuffer.isView(data)) {
        return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      if (isArrayBuffer(data)) {
        return Promise.resolve(new Uint8Array(data));
      }
      return Promise.reject(new TypeError('RawZip: unsupported entry data type for "' + data + '"'));
    }

    /* ------------------------------------------------------------------ *
     * DOS date/time (local time, valid range 1980-01-01 .. 2107-12-31)   *
     * ------------------------------------------------------------------ */

    function toDosStamp(input) {
      var d = (input instanceof Date && !isNaN(input.getTime())) ? input : new Date();
      var year = d.getFullYear();
      if (year < 1980) {
        d = new Date(1980, 0, 1, 0, 0, 0);
      } else if (year > 2107) {
        d = new Date(2107, 11, 31, 23, 59, 58);
      }
      var dosTime =
        (d.getHours() << 11) |
        (d.getMinutes() << 5) |
        (Math.floor(d.getSeconds() / 2));
      var dosDate =
        ((d.getFullYear() - 1980) << 9) |
        ((d.getMonth() + 1) << 5) |
        d.getDate();
      return { time: dosTime & UINT16_MAX, date: dosDate & UINT16_MAX };
    }

    /* ------------------------------------------------------------------ *
     * Record builders                                                    *
     * ------------------------------------------------------------------ */

    function buildLocalHeader(entry) {
      var buf = new Uint8Array(LOCAL_HEADER_SIZE + entry.nameBytes.length);
      var view = new DataView(buf.buffer);
      view.setUint32(0, SIG_LOCAL, true);
      view.setUint16(4, VERSION_NEEDED, true);
      view.setUint16(6, FLAG_UTF8, true);
      view.setUint16(8, METHOD_STORE, true);
      view.setUint16(10, entry.time, true);
      view.setUint16(12, entry.date, true);
      view.setUint32(14, entry.crc, true);
      view.setUint32(18, entry.size, true); // compressed size (== size, STORE)
      view.setUint32(22, entry.size, true); // uncompressed size
      view.setUint16(26, entry.nameBytes.length, true);
      view.setUint16(28, 0, true);          // extra field length
      buf.set(entry.nameBytes, LOCAL_HEADER_SIZE);
      return buf;
    }

    function buildCentralHeader(entry, localOffset) {
      var buf = new Uint8Array(CENTRAL_HEADER_SIZE + entry.nameBytes.length);
      var view = new DataView(buf.buffer);
      view.setUint32(0, SIG_CENTRAL, true);
      view.setUint16(4, VERSION_MADE_BY, true);
      view.setUint16(6, VERSION_NEEDED, true);
      view.setUint16(8, FLAG_UTF8, true);
      view.setUint16(10, METHOD_STORE, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true); // compressed size
      view.setUint32(24, entry.size, true); // uncompressed size
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);          // extra field length
      view.setUint16(32, 0, true);          // file comment length
      view.setUint16(34, 0, true);          // disk number start
      view.setUint16(36, 0, true);          // internal file attributes
      view.setUint32(38, 0, true);          // external file attributes
      view.setUint32(42, localOffset, true);
      buf.set(entry.nameBytes, CENTRAL_HEADER_SIZE);
      return buf;
    }

    function buildEndOfCentralDirectory(count, centralSize, centralOffset) {
      var buf = new Uint8Array(EOCD_SIZE);
      var view = new DataView(buf.buffer);
      view.setUint32(0, SIG_EOCD, true);
      view.setUint16(4, 0, true);  // number of this disk
      view.setUint16(6, 0, true);  // disk where central directory starts
      view.setUint16(8, count, true);   // entries on this disk
      view.setUint16(10, count, true);  // total entries
      view.setUint32(12, centralSize, true);
      view.setUint32(16, centralOffset, true);
      view.setUint16(20, 0, true); // archive comment length
      return buf;
    }

    /* ------------------------------------------------------------------ *
     * Entry preparation                                                  *
     * ------------------------------------------------------------------ */

    function prepareEntry(file, index, stamp) {
      return Promise.resolve().then(function () {
        if (!file || typeof file !== 'object') {
          throw new TypeError('RawZip: files[' + index + '] must be an object');
        }
        var name = file.name;
        if (typeof name !== 'string' || name.length === 0) {
          throw new TypeError('RawZip: files[' + index + '].name must be a non-empty string');
        }
        if (name.indexOf('\u0000') !== -1) {
          throw new TypeError('RawZip: files[' + index + '].name must not contain NUL');
        }
        var nameBytes = utf8Encode(name);
        if (nameBytes.length > UINT16_MAX) {
          throw new RangeError('RawZip: entry name exceeds 65535 UTF-8 bytes (ZIP64 not supported): ' + name);
        }
        return toBytes(file.data).then(function (bytes) {
          if (bytes.length > UINT32_MAX) {
            throw new RangeError('RawZip: entry "' + name + '" exceeds the 4 GiB ZIP limit (ZIP64 not supported)');
          }
          return {
            nameBytes: nameBytes,
            data: bytes,
            size: bytes.length,
            crc: crc32(bytes),
            time: stamp.time,
            date: stamp.date
          };
        });
      });
    }

    function readEntriesSequentially(files, stamp) {
      var entries = [];
      var chain = Promise.resolve();
      files.forEach(function (file, index) {
        chain = chain.then(function () {
          return prepareEntry(file, index, stamp).then(function (entry) {
            entries.push(entry);
          });
        });
      });
      return chain.then(function () {
        return entries;
      });
    }

    /* ------------------------------------------------------------------ *
     * Archive assembly                                                   *
     * ------------------------------------------------------------------ */

    function buildZipBlob(entries) {
      var localParts = [];
      var centralParts = [];
      var offset = 0;
      var i;

      for (i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (offset > UINT32_MAX) {
          throw new RangeError('RawZip: archive exceeds the 4 GiB ZIP limit (ZIP64 not supported)');
        }
        var localHeader = buildLocalHeader(entry);
        localParts.push(localHeader, entry.data);
        centralParts.push(buildCentralHeader(entry, offset));
        offset += localHeader.length + entry.size;
      }
      if (offset > UINT32_MAX) {
        throw new RangeError('RawZip: archive exceeds the 4 GiB ZIP limit (ZIP64 not supported)');
      }

      var centralSize = 0;
      for (i = 0; i < centralParts.length; i++) {
        centralSize += centralParts[i].length;
      }
      if (centralSize > UINT32_MAX || offset + centralSize > UINT32_MAX) {
        throw new RangeError('RawZip: central directory exceeds the 4 GiB ZIP limit (ZIP64 not supported)');
      }

      var eocd = buildEndOfCentralDirectory(entries.length, centralSize, offset);
      var blobParts = localParts.concat(centralParts, [eocd]);
      return new Blob(blobParts, { type: 'application/zip' });
    }

    /* ------------------------------------------------------------------ *
     * Public API                                                         *
     * ------------------------------------------------------------------ */

    function create(files, options) {
      return Promise.resolve().then(function () {
        if (!Array.isArray(files)) {
          throw new TypeError('RawZip: files must be an array of { name, data }');
        }
        if (typeof Blob !== 'function') {
          throw new Error('RawZip: Blob is not available in this environment');
        }
        if (files.length > UINT16_MAX) {
          throw new RangeError('RawZip: more than 65535 entries requires ZIP64 (not supported)');
        }
        var stamp = toDosStamp(options && options.date);
        return readEntriesSequentially(files, stamp);
      }).then(buildZipBlob);
    }

    return {
      create: create,
      crc32: crc32,
      VERSION: '1.0.0'
    };
  }
);
