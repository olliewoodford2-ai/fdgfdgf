"use strict";

// Minimal "store" (no compression) ZIP writer. No dependencies.
(function (root) {
  const encoder = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function sanitizeZipPath(path) {
    return String(path)
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .join("/");
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: day };
  }

  const UTF8_FLAG = 0x0800; // file names are UTF-8

  function localHeader(nameBytes, crc, size, stamp) {
    const out = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, UTF8_FLAG, true);
    v.setUint16(8, 0, true); // method: stored
    v.setUint16(10, stamp.time, true);
    v.setUint16(12, stamp.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    out.set(nameBytes, 30);
    return out;
  }

  function centralHeader(nameBytes, crc, size, stamp, offset) {
    const out = new Uint8Array(46 + nameBytes.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, UTF8_FLAG, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, stamp.time, true);
    v.setUint16(14, stamp.date, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, size, true);
    v.setUint32(24, size, true);
    v.setUint16(28, nameBytes.length, true);
    v.setUint32(42, offset, true);
    out.set(nameBytes, 46);
    return out;
  }

  function createZip(files) {
    // Later duplicates win, empty names are dropped.
    const unique = new Map();
    for (const [name, content] of Object.entries(files)) {
      const clean = sanitizeZipPath(name);
      if (clean) unique.set(clean, String(content ?? ""));
    }

    const stamp = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const [name, content] of unique) {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(content);
      const crc = crc32(data);
      const local = localHeader(nameBytes, crc, data.length, stamp);
      parts.push(local, data);
      central.push(centralHeader(nameBytes, crc, data.length, stamp, offset));
      offset += local.length + data.length;
    }

    const centralSize = central.reduce((sum, p) => sum + p.length, 0);
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, unique.size, true);
    v.setUint16(10, unique.size, true);
    v.setUint32(12, centralSize, true);
    v.setUint32(16, offset, true);

    const all = [...parts, ...central, end];
    const total = all.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const p of all) {
      result.set(p, pos);
      pos += p.length;
    }
    return result;
  }

  root.createZip = createZip;
  if (typeof module !== "undefined" && module.exports) module.exports = { createZip, crc32, sanitizeZipPath };
})(typeof self !== "undefined" ? self : globalThis);
