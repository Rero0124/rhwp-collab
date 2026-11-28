#!/usr/bin/env node
// 6단계 S2 왕복 점검 전수 측정: 업스트림 샘플(upstream/rhwp/samples, 읽기만)마다 문서를 열어 collabRoundtripCheck 를 한 번
// 부르고, 통과·경고 분포와 걸린 시간, 경고 종류를 센다. 서버가 POST /rooms 에서 하는 것과 같은 호출이다.
//
//   node scripts/roundtrip-survey.mjs [--json 결과.json] [--limit N] [샘플 디렉터리]
//
// 보조(collab-core collabRoundtripCheck)가 빌드에 없으면 알리고 멈춘다(scripts/build-wasm.sh 를 다시).
// 결과 파일은 문서 내용이 아니라 파일 이름·점검 결과만 담는다. 저장소 밖에 둔다.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ options: { json: { type: 'string' }, limit: { type: 'string' } }, allowPositionals: true });
const dir = positionals[0] ?? path.join(root, 'upstream/rhwp/samples');
const pkg = path.join(root, 'upstream/rhwp/pkg');
const wasm = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
wasm.initSync({ module: readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
if (typeof wasm.HwpDocument.prototype.collabRoundtripCheck !== 'function') {
  console.error('roundtrip-survey: 빌드에 collabRoundtripCheck 가 없습니다(6단계 S2 보조가 합쳐진 뒤 scripts/build-wasm.sh)');
  process.exit(2);
}

/** 샘플 파일(.hwp·.hwpx) 전부 — 하위 디렉터리 포함 */
function files(d) {
  const out = [];
  for (const name of readdirSync(d).sort()) {
    const p = path.join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...files(p));
    else if (/\.(hwp|hwpx)$/i.test(name)) out.push(p);
  }
  return out;
}

const list = files(dir).slice(0, values.limit ? Number(values.limit) : undefined);
const results = [];
for (const file of list) {
  const rel = path.relative(dir, file);
  const bytes = statSync(file).size;
  let doc;
  const o0 = performance.now();
  try {
    doc = new wasm.HwpDocument(readFileSync(file));
  } catch (error) {
    const reason = String(error?.message ?? error);
    results.push({ file: rel, bytes, status: /비밀번호가 필요한 암호 문서/.test(reason) ? 'encrypted' : 'unreadable', reason: reason.slice(0, 120) });
    continue;
  }
  const openMs = Math.round((performance.now() - o0) * 10) / 10;
  try {
    const t0 = performance.now();
    const raw = doc.collabRoundtripCheck();
    const ms = performance.now() - t0;
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const lost = Array.isArray(r?.lost) ? r.lost : [];
    results.push({ file: rel, bytes, openMs, status: r?.ok === true && lost.length === 0 ? 'ok' : 'warn', ms: Math.round(ms * 10) / 10, lost, irDiff: r?.irDiff ?? 0 });
  } catch (error) {
    results.push({ file: rel, bytes, openMs, status: 'error', reason: String(error?.message ?? error).slice(0, 120) });
  } finally {
    doc.free();
  }
}

const by = (s) => results.filter((r) => r.status === s);
const times = results.filter((r) => typeof r.ms === 'number').map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] : 0);
const kinds = new Map();
const kindCounts = new Map();
for (const r of by('warn')) for (const l of r.lost) { kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1); kindCounts.set(l.kind, (kindCounts.get(l.kind) ?? 0) + (l.count ?? 0)); }
const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;

console.log(`샘플 ${results.length}개 (${dir})`);
console.log(`  통과 ${by('ok').length} · 경고 ${by('warn').length} · 점검 오류 ${by('error').length} · 암호 ${by('encrypted').length} · 못 읽음 ${by('unreadable').length}`);
console.log(`  걸린 시간(ms): 중앙값 ${pct(50)} · p95 ${pct(95)} · 최대 ${times.at(-1) ?? 0}`);
console.log(`  경고 종류(문서 수 / 개수 합): ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}/${kindCounts.get(k)}`).join(', ') || '없음'}`);
const big = results.filter((r) => typeof r.ms === 'number').sort((a, b) => b.bytes - a.bytes).slice(0, 5);
console.log(`  큰 문서(열기 + 점검 ms): ${big.map((r) => `${mb(r.bytes)} ${r.openMs}+${r.ms}`).join(' · ')}`);
const slow = results.filter((r) => typeof r.ms === 'number').sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`  느린 점검: ${slow.map((r) => `${r.file} (${mb(r.bytes)}) ${r.ms}ms`).join(' · ')}`);
for (const r of by('warn').slice(0, 20)) {
  console.log(`  경고 ${r.file}: ${r.lost.map((l) => `${l.kind}×${l.count}${l.detail ? `(${String(l.detail).slice(0, 60)})` : ''}`).join(', ') || `IR 차이 ${r.irDiff}`}`);
}
for (const r of by('error')) console.log(`  점검 오류 ${r.file}: ${r.reason}`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(results, null, 1)}\n`);
