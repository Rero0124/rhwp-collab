// S3-3 영속 저장 (docs/collab-stage3.md S3-3, 결정 2026-11-26 "계보 보존"). 저장소는 인터페이스(DocStore)로 두고
// 로컬 디스크 구현만 만든다.
//
// 방 디렉터리(`<root>/<방 이름을 안전하게 바꾼 것>/`):
//   base.hwp | base.hwpx  기준점 — 이 세대의 모든 문서가 출발한 바이트(처음 base 또는 세대 전환 때 정본을 내보내
//                         정본도 다시 읽은 바이트). 복원은 이것 + 기록만 쓴다.
//   log.jsonl             기준점 뒤 기록 전부, 한 줄에 한 묶음 {seq, clientId, entries, batchId?}. 세대 전환 때만 비운다.
//                         (기록 안의 state 항목도 기준점이지만 파일에서는 지우지 않는다 — 재생하면 같은 바이트를
//                         다시 읽으므로 결과가 같다. welcome 의 기준점은 메모리에서 고른다.)
//   doc.hwp | doc.hwpx    사용자 저장본("원본 파일에 저장"). 정본을 내보낸 것. 재생 기준으로 쓰지 않는다
//                         (엔진 업그레이드 때 마지막 seq 까지 덮고 있으면 새 기준점으로만).
//   meta.json             {room, generation, baseSeq, engine, baseFormat, docSeq, docFormat, encryptedSource?, savedAt}
//
// 쓰기 규칙: 기록은 매 묶음 덧붙이고 fsync 한 뒤에 돌아온다(방송은 그다음). 파일은 임시 파일에 쓰고 fsync →
// rename(원자적) → 디렉터리 fsync. 세대 전환은 base → meta → 기록 비우기 순서라, 어느 단계에서 죽어도 다시 열면
// (meta 의 baseSeq 와 기록의 seq 로) 일관된 상태가 나온다 — 기록 중 baseSeq 이하인 줄은 건너뛴다.
import { promises as fs, constants as FS } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * @typedef {{ seq: number, clientId: string, entries: unknown[], batchId?: string }} LogItem
 * @typedef {{ room: string, generation: number, baseSeq: number, engine: string, baseFormat: 'hwp'|'hwpx',
 *   docSeq: number|null, docFormat: 'hwp'|'hwpx'|null, encryptedSource?: true, savedAt: string }} Meta
 * @typedef {{ meta: Meta, base: Buffer, log: LogItem[], doc: Buffer|null }} Saved
 *
 * @typedef {object} DocStore
 * @property {(room: string) => Promise<Saved|null>} load
 * @property {(room: string, item: LogItem) => Promise<void>} append
 * @property {(room: string, b: { baseSeq: number, data: Buffer, engine: string, generation: number }) => Promise<Meta>} setBase
 * @property {(room: string, d: { seq: number, data: Buffer }) => Promise<Meta>} saveDoc
 * @property {() => Promise<string[]>} rooms
 */

const HWP3_SIGNATURE = Buffer.from('HWP Document File');

/** 원본 바이트로 형식을 가린다 — HWPX 는 ZIP(PK), HWP 는 CFB, HWP3 는 "HWP Document File" 머리(HWP 계열로 둔다). */
export function formatOf(raw) {
  if (raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4b) return 'hwpx';
  if (raw.length >= 8 && raw.readUInt32BE(0) === 0xd0cf11e0) return 'hwp';
  if (raw.length >= HWP3_SIGNATURE.length && Buffer.from(raw.buffer, raw.byteOffset, HWP3_SIGNATURE.length).equals(HWP3_SIGNATURE)) return 'hwp';
  throw new Error('HWP·HWPX 가 아니다');
}

/** 방 이름 → 디렉터리 이름. 경로 문자를 쓰지 않고(탈출 방지), 사람이 알아보게 앞부분을 남긴다. */
export function roomDirName(room) {
  const readable = room.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 40);
  const hash = createHash('sha256').update(room).digest('hex').slice(0, 16);
  return `${readable || 'room'}-${hash}`;
}

async function fsyncPath(p, flags = FS.O_RDONLY) {
  const fh = await fs.open(p, flags);
  try { await fh.sync(); } finally { await fh.close(); }
}

/** 임시 파일에 쓰고 fsync → rename → 디렉터리 fsync. */
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  await fsyncPath(path.dirname(file));
}

/** @implements {DocStore} */
export class LocalDocStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  dir(room) { return path.join(this.root, roomDirName(room)); }

  async rooms() {
    let names = [];
    try { names = await fs.readdir(this.root); } catch { return []; }
    const out = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(this.root, name, 'meta.json'), 'utf8'));
        if (typeof meta.room === 'string') out.push(meta.room);
      } catch { /* 기준점이 없는 디렉터리 */ }
    }
    return out;
  }

  async readMeta(room) {
    return JSON.parse(await fs.readFile(path.join(this.dir(room), 'meta.json'), 'utf8'));
  }

  /** @returns {Promise<Saved|null>} 기준점이 없으면 null */
  async load(room) {
    const dir = this.dir(room);
    let meta;
    try { meta = await this.readMeta(room); } catch { return null; }
    const base = await fs.readFile(path.join(dir, `base.${meta.baseFormat}`));
    let doc = null;
    if (meta.docFormat) { try { doc = await fs.readFile(path.join(dir, `doc.${meta.docFormat}`)); } catch { doc = null; } }
    let text = '';
    try { text = await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8'); } catch { /* 기록 없음 */ }
    const log = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch (error) {
        // 마지막 줄이 쓰다 만 것이면(fsync 전 죽음) 버린다 — 그 묶음은 방송되지 않았다. 중간 줄이 깨졌으면 오류.
        if (lines.slice(i + 1).every((l) => !l)) break;
        throw new Error(`${room}: 기록 ${i + 1}번째 줄이 깨졌다 (${error.message})`);
      }
      if (item.seq <= meta.baseSeq) continue; // 세대 전환 뒤 기록을 비우기 전에 죽은 경우
      if (log.length && item.seq !== log[log.length - 1].seq + 1) throw new Error(`${room}: 기록 seq 가 끊겼다 (${log[log.length - 1].seq} → ${item.seq})`);
      if (!log.length && item.seq !== meta.baseSeq + 1) throw new Error(`${room}: 기록이 기준점 seq ${meta.baseSeq} 다음부터가 아니다 (${item.seq})`);
      log.push(item);
    }
    return { meta, base, log, doc };
  }

  async append(room, item) {
    const fh = await fs.open(path.join(this.dir(room), 'log.jsonl'), 'a');
    try {
      await fh.appendFile(`${JSON.stringify(item)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** 새 기준점(방 생성·세대 전환): base 를 원자적으로 쓰고 meta 를 바꾼 뒤 기록을 비운다. 저장본 정보는 유지. */
  async setBase(room, { baseSeq, data, engine, generation, encryptedSource }) {
    const dir = this.dir(room);
    await fs.mkdir(dir, { recursive: true });
    const baseFormat = formatOf(data);
    await writeAtomic(path.join(dir, `base.${baseFormat}`), data);
    await fs.rm(path.join(dir, `base.${baseFormat === 'hwp' ? 'hwpx' : 'hwp'}`), { force: true });
    let prev = null;
    try { prev = await this.readMeta(room); } catch { /* 새 방 */ }
    /** @type {Meta} */
    // encryptedSource(5단계 D5): 원래 암호 문서였다 — 주지 않으면 앞 세대의 값을 잇는다(세대 전환)
    const enc = encryptedSource ?? prev?.encryptedSource ?? false;
    const meta = { room, generation, baseSeq, engine, baseFormat, docSeq: prev?.docSeq ?? null, docFormat: prev?.docFormat ?? null, ...(enc ? { encryptedSource: true } : {}), savedAt: new Date().toISOString() };
    await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
    await writeAtomic(path.join(dir, 'log.jsonl'), '');
    return meta;
  }

  /** 사용자 저장본: 정본을 내보낸 바이트를 doc.<ext> 로, 덮은 seq 를 meta 에. */
  async saveDoc(room, { seq, data }) {
    const dir = this.dir(room);
    const docFormat = formatOf(data);
    await writeAtomic(path.join(dir, `doc.${docFormat}`), data);
    await fs.rm(path.join(dir, `doc.${docFormat === 'hwp' ? 'hwpx' : 'hwp'}`), { force: true });
    const meta = { ...(await this.readMeta(room)), docSeq: seq, docFormat, savedAt: new Date().toISOString() };
    await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
    return meta;
  }
}
