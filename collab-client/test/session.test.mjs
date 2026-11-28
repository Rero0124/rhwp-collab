// 세션 인증 계층(collab-client/src/session, docs/collab-stage5.md D0): 토큰 공급자 호출 까닭, 만료 때 한 번 갱신,
// 이유 코드 분류, hello 모양. 플랫폼 중립이라 Node 에서 그대로 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthSession, buildHello, classifyUnauthorized, editLevel, knownUnauthorized } from '../src/session/index.ts';

test('토큰 공급자: 처음은 connect, 다시 붙을 때 reconnect', async () => {
  const asked = [];
  const s = new AuthSession({ room: 'r', getToken: ({ room, reason }) => { asked.push([room, reason]); return `t-${reason}`; } });
  assert.equal(await s.helloToken(), 't-connect');
  assert.equal(await s.helloToken(), 't-reconnect');
  assert.deepEqual(asked, [['r', 'connect'], ['r', 'reconnect']]);
});

test('expired: 한 번 새 토큰을 받아 곧바로 다시 붙고, 또 만료면 포기. 방에 들어가면 횟수를 되돌린다', async () => {
  const asked = [];
  let n = 0;
  const s = new AuthSession({ room: 'r', getToken: ({ reason }) => { asked.push(reason); return `t${n++}`; } });
  await s.helloToken();
  assert.deepEqual(await s.onUnauthorized('expired'), { action: 'reconnect' });
  assert.equal(await s.helloToken(), 't1', '갱신한 토큰을 다음 hello 에');
  assert.deepEqual(await s.onUnauthorized('expired'), { action: 'give-up', reason: 'expired' });
  s.admitted({ sub: 'u', name: 'n', scope: ['edit'] });
  assert.deepEqual(s.user, { sub: 'u', name: 'n', scope: ['edit'] });
  assert.deepEqual(await s.onUnauthorized('expired'), { action: 'reconnect' }, '들어간 뒤의 만료는 다시 한 번');
  assert.deepEqual(asked, ['connect', 'expired', 'expired']);
});

test('갱신할 수 없는 공급자(null·오류)는 만료에서 곧바로 포기, 연결 때 오류는 토큰 없음', async () => {
  const s = new AuthSession({ room: 'r', getToken: ({ reason }) => { if (reason === 'expired') return null; throw new Error('x'); } });
  assert.equal(await s.helloToken(), null);
  assert.deepEqual(await s.onUnauthorized('expired'), { action: 'give-up', reason: 'expired' });
  const none = new AuthSession({ room: 'r' });
  assert.equal(await none.helloToken(), null, '공급자가 없으면 토큰 없이(인증을 끈 서버)');
});

test('이유 코드: unavailable 은 백오프, 나머지는 포기, 모르는 코드는 invalid', async () => {
  const s = new AuthSession({ room: 'r', getToken: () => 't' });
  assert.deepEqual(await s.onUnauthorized('unavailable'), { action: 'backoff' });
  for (const r of ['missing', 'invalid', 'room', 'scope', 'no-room']) {
    assert.deepEqual(await s.onUnauthorized(r), { action: 'give-up', reason: r });
  }
  assert.deepEqual(await s.onUnauthorized('new-reason'), { action: 'give-up', reason: 'invalid' });
  assert.equal(classifyUnauthorized('expired'), 'refresh');
  assert.equal(knownUnauthorized('room'), 'room');
});

test('hello 모양: 토큰·재접속 정보는 있을 때만', () => {
  assert.deepEqual(buildHello({ room: 'r', clientId: 'c', name: 'n', engine: 'e' }), { type: 'hello', room: 'r', clientId: 'c', name: 'n', engine: 'e' });
  assert.deepEqual(buildHello({ room: 'r', clientId: 'c', name: 'n', engine: 'e', token: 'T', resume: { lastSeq: 4, generation: 1 } }),
    { type: 'hello', room: 'r', clientId: 'c', name: 'n', engine: 'e', lastSeq: 4, generation: 1, token: 'T' });
});

test('편집 권한 수준', () => {
  assert.equal(editLevel(['edit']), 'edit');
  assert.equal(editLevel(['view', 'edit']), 'edit');
  assert.equal(editLevel(['form']), 'confined');
  assert.equal(editLevel(['comment', 'view']), 'confined');
  assert.equal(editLevel(['view']), 'none');
  assert.equal(editLevel([]), 'none');
});

test('판단(새 토큰 받기) 중에 다시 붙으면 hello 토큰은 판단이 끝난 뒤의 새 토큰', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = new AuthSession({ room: 'r', getToken: async ({ reason }) => { if (reason === 'expired') { await gate; return 'fresh'; } return 'old'; } });
  assert.equal(await s.helloToken(), 'old');
  const decision = s.onUnauthorized('expired');
  const next = s.helloToken(); // 연결이 먼저 열림
  release();
  assert.deepEqual(await decision, { action: 'reconnect' });
  assert.equal(await next, 'fresh');
});

test('왕복 점검 문구(6단계 S2): 통과, 경고(종류 이름·개수, 없으면 내용 차이), block 거절', async () => {
  const { roundtripText, roundtripBlockedText, ROUNDTRIP_OK_TEXT } = await import('../src/session/index.ts');
  assert.equal(roundtripText({ ok: true, lost: [], irDiff: 0 }), ROUNDTRIP_OK_TEXT);
  assert.equal(roundtripText({ ok: false, lost: [{ kind: 'ole-clsid', count: 2 }, { kind: 'mystery', count: 1 }], irDiff: 0 }),
    '이 문서에는 rhwp 가 다 다루지 못하는 부분이 있습니다: OLE 개체 2개, mystery 1개. 이 부분이 있는 쪽을 편집하면 사라질 수 있습니다');
  assert.match(roundtripText({ ok: false, lost: [], irDiff: 4 }), /내용 차이 4곳/);
  // 7단계 B 배치 점검: 쪽 단위, 배치만 끝내지 못하면 덧붙임
  // 배치만: 배치 문장 하나(쪽 수가 달라지면 그것, 아니면 가장 많이 움직인 쪽) / 내용 손실과 함께면 두 문장 / 막힌 방은 목록
  assert.equal(roundtripText({ ok: false, lost: [{ kind: 'layout', count: 2, pages: [12, 13], maxDisp: 3.5, worstPage: 5 }], irDiff: 0 }),
    'rhwp 가 이 문서를 다시 쓰면 일부 쪽의 배치(줄 높이·위치)가 달라질 수 있습니다(쪽 수 12 → 13)');
  assert.equal(roundtripText({ ok: false, lost: [{ kind: 'layout', count: 2, pages: [12, 12], maxDisp: 3.5, worstPage: 5 }], irDiff: 0 }),
    'rhwp 가 이 문서를 다시 쓰면 일부 쪽의 배치(줄 높이·위치)가 달라질 수 있습니다(5쪽 등)');
  assert.equal(roundtripText({ ok: false, lost: [{ kind: 'record', count: 1 }, { kind: 'layout', count: 1, pages: [3, 3], maxDisp: 1.5, worstPage: 2 }], irDiff: 0 }),
    '이 문서에는 rhwp 가 다 다루지 못하는 부분이 있습니다: rhwp 가 모르는 레코드 1개. 이 부분이 있는 쪽을 편집하면 사라질 수 있습니다. rhwp 가 이 문서를 다시 쓰면 일부 쪽의 배치(줄 높이·위치)가 달라질 수 있습니다(2쪽)');
  assert.match(roundtripBlockedText({ ok: false, lost: [{ kind: 'layout', count: 2, pages: [3, 3] }], irDiff: 0 }), /: 조판\(쪽·위치\) 2쪽$/);
  assert.equal(roundtripText({ ok: true, lost: [], irDiff: 0, layoutUnknown: 'timeout' }), `${ROUNDTRIP_OK_TEXT} (조판 점검 못 함: 시간 초과)`);
  // collab-core 가 내는 종류: ir(곳)·record·bindata·ole-clsid·cfb·package
  assert.match(roundtripText({ ok: false, lost: [{ kind: 'ir', count: 4 }, { kind: 'bindata', count: 1 }, { kind: 'package', count: 2 }], irDiff: 4 }), /: 내용 차이 4곳, 그림·첨부 데이터 1개, 파일 구조 2개\./);
  assert.equal(roundtripBlockedText({ ok: false, lost: [{ kind: 'record', count: 3 }], irDiff: 0 }), 'rhwp 가 이 문서의 일부를 다루지 못해 방을 만들지 않았습니다: rhwp 가 모르는 레코드 3개');
  assert.equal(roundtripBlockedText(null), 'rhwp 가 이 문서의 일부를 다루지 못해 방을 만들지 않았습니다');
  // 점검 못 함(시간 상한·오류)·뒤에서 도는 중
  const { isRoundtripPending, ROUNDTRIP_PENDING_TEXT } = await import('../src/session/index.ts');
  assert.match(roundtripText({ ok: null, reason: 'timeout', lost: [], irDiff: 0 }), /^왕복 점검 못 함\(시간 초과\)/);
  assert.match(roundtripText({ ok: null, reason: 'error', lost: [], irDiff: 0 }), /^왕복 점검 못 함\(오류\)/);
  assert.equal(roundtripBlockedText({ ok: null, reason: 'timeout', lost: [], irDiff: 0 }), '왕복 점검을 끝내지 못해(시간 초과) 방을 만들지 않았습니다');
  assert.equal(isRoundtripPending({ pending: true }), true);
  assert.equal(isRoundtripPending({ ok: true, lost: [], irDiff: 0 }), false);
  assert.match(ROUNDTRIP_PENDING_TEXT, /방에 들어가면 보입니다/);
});
