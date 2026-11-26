// R5·R11 무작위 시뮬레이션의 작은 정규 시험. 관문(시드 500 × 연산 200)은 sim.mjs 를 직접 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sim = fileURLToPath(new URL('./sim.mjs', import.meta.url));
const run = (...args) => {
  const r = spawnSync(process.execPath, [sim, ...args], { encoding: 'utf8', env: process.env });
  const at = r.stdout.indexOf('{\n "seeds"');
  return { status: r.status, out: r.stdout + r.stderr, summary: at >= 0 ? JSON.parse(r.stdout.slice(at, r.stdout.indexOf('\n}', at) + 2)) : null };
};

test('R5: 무작위 3 클라이언트 동시 편집이 수렴한다 (시드 3 × 연산 100, 빠른 경로 켬)', () => {
  const { status, out, summary } = run('--seeds', '3', '--ops', '100');
  assert.equal(status, 0, out);
  assert.equal(summary.failed, 0);
  assert.equal(Object.keys(summary.dropReasons).filter((k) => k.includes('재적용 실패')).length, 0, '보정한 연산은 다시 적용돼야 한다');
});

test('R11: text·neutral 만, 빠른 경로 결과 = 되감기 결과 (시드 3 × 연산 150)', () => {
  const { status, out, summary } = run('--mix', 'tn', '--verify-fast', '--seeds', '3', '--ops', '150');
  assert.equal(status, 0, out);
  assert.equal(summary.failed, 0);
  assert.equal(summary.fastMismatches, 0);
  assert.ok(summary.fastPath.fast > 0, '빠른 경로를 실제로 탔다');
});
