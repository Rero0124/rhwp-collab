// 시험 도우미: HWP(복합 파일) 스트림을 읽고, 구역·DocInfo 스트림에 rhwp 가 모르는 태그의 레코드를 끼운다(위조 사례).
// 그 스트림 마지막 섹터의 남는 자리를 쓰고 디렉터리 항목의 크기만 고친다(파일 구조를 다시 쓰지 않는다).
// rewrite.test(6단계 S1 다시 쓰기)와 roundtrip.test(S2 왕복 점검)가 같이 쓴다.
import assert from 'node:assert/strict';
import { inflateRawSync, deflateRawSync } from 'node:zlib';

// ── 복합 파일(CFB)·HWP 레코드 ─────────────────────────────────────────

/** CFB 안 스트림: 디렉터리 항목 위치·크기와, 그 스트림에 잡힌 바이트 전부(마지막 섹터의 남는 자리 포함)의 위치 */
export function cfbStream(buf, name) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const at = (sid) => (sid + 1) * sectorSize;
  const fat = [];
  for (let i = 0; i < 109; i += 1) { const sid = u32(0x4c + i * 4); if (sid >= 0xfffffffa) break; fat.push(sid); }
  const next = (table, sid) => u32(at(table[Math.floor((sid * 4) / sectorSize)]) + ((sid * 4) % sectorSize));
  const chain = (start, table = fat) => { const out = []; for (let sid = start; sid < 0xfffffffa; sid = next(table, sid)) out.push(sid); return out; };
  const entries = chain(u32(0x30)).flatMap((sid) => Array.from({ length: sectorSize / 128 }, (_, k) => at(sid) + k * 128));
  const nameOf = (o) => Buffer.from(buf.subarray(o, o + Math.max(0, dv.getUint16(o + 0x40, true) - 2))).toString('utf16le');
  const entry = entries.find((o) => buf[o + 0x42] === 2 && nameOf(o) === name);
  assert.ok(entry !== undefined, `스트림 ${name} 없음`);
  const [start, size, cutoff] = [u32(entry + 0x74), u32(entry + 0x78), u32(0x38)];
  if (size >= cutoff) {
    return { entry, size, mini: false, cutoff, offsets: chain(start).flatMap((s) => Array.from({ length: sectorSize }, (_, i) => at(s) + i)) };
  }
  const miniStream = chain(u32(entries[0] + 0x74));
  const minis = chain(start, chain(u32(0x3c)));
  return {
    entry, size, mini: true, cutoff,
    offsets: minis.flatMap((m) => Array.from({ length: miniSize }, (_, i) => { const pos = m * miniSize + i; return at(miniStream[Math.floor(pos / sectorSize)]) + (pos % sectorSize); })),
  };
}
/** CFB 스트림(HWP 는 raw deflate 로 압축)을 풀어 레코드 바이트로 */
export const streamBytes = (hwp, name) => { const s = cfbStream(hwp, name); return inflateRawSync(Buffer.from(s.offsets.slice(0, s.size).map((o) => hwp[o]))); };
export const sectionBytes = (hwp) => streamBytes(hwp, 'Section0');
/** HWP 레코드 목록(태그만) */
export function recordTags(plain) {
  const out = [];
  for (let p = 0; p + 4 <= plain.length;) {
    const h = plain.readUInt32LE(p);
    let size = h >>> 20;
    let hdr = 4;
    if (size === 0xfff) { size = plain.readUInt32LE(p + 4); hdr = 8; }
    out.push(h & 0x3ff);
    p += hdr + size;
  }
  return out;
}
/** 모르는 태그(rhwp 가 모델에 남기지 않는 레코드) */
export const EVIL_TAG = 0x3f0;
export const hasEvil = (hwp, stream = 'Section0') => recordTags(streamBytes(hwp, stream)).includes(EVIL_TAG);

/** HWP 바이트의 스트림(구역 0 또는 DocInfo) 끝에 모르는 레코드를 끼운다. 그 스트림에 남는 자리가 없으면 null */
export function injectEvil(hwp, stream = 'Section0', payload = Buffer.from('EVIL-RECORD')) {
  const s = cfbStream(hwp, stream);
  const plain = inflateRawSync(Buffer.from(s.offsets.slice(0, s.size).map((o) => hwp[o])));
  const record = Buffer.alloc(4 + payload.length);
  record.writeUInt32LE(EVIL_TAG | (payload.length << 20), 0);
  payload.copy(record, 4);
  const forged = deflateRawSync(Buffer.concat([plain, record]), { level: 9 });
  if (forged.length > s.offsets.length || (s.mini && forged.length >= s.cutoff)) return null;
  const out = Buffer.from(hwp);
  forged.forEach((b, i) => { out[s.offsets[i]] = b; });
  out.writeUInt32LE(forged.length, s.entry + 0x78);
  return out;
}
