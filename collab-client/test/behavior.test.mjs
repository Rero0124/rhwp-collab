// R1b 동작 동일성 검사의 작은 정규 시험: 같은 빌드끼리 비교하면 "같음"이고 재생 가능성도 지킨다.
// 전체 검사(op 전부)는 scripts/check-behavior.mjs 를 직접 돌린다(수 분).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pkg = join(root, 'upstream/rhwp/pkg');

test('같은 빌드끼리: 고른 기능이 모두 "같음" (사례 자동 생성·손으로 쓴 틀·준비 단계 포함)', () => {
  const report = join(mkdtempSync(join(tmpdir(), 'r1b-')), 'report.json');
  const only = 'insertText,applyCharFormat,splitParagraph,createTable,deleteBookmark,setFieldValueByName,applyCharFormatInHeaderFooter,insertHyperlinkEx';
  const r = spawnSync(process.execPath, [join(root, 'scripts/check-behavior.mjs'), '--dry', '--only', only, '--old', pkg, '--new', pkg, '--attempts', '120', '--report', report], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { report: res } = JSON.parse(readFileSync(report, 'utf8'));
  for (const name of only.split(',')) {
    assert.equal(res[name]?.verdict, 'same', `${name}: ${JSON.stringify(res[name])}`);
    assert.ok(res[name].cases >= 5, `${name}: 사례 5개 이상`);
  }
});
