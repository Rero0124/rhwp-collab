// 5단계 D3: studio 안 "공동편집 시작" 메뉴(launcher) — 서버 확인·만들기 토큰·링크 규칙·방 만들기 오류, 그리고 켤 때
// 서버가 없거나 url 방식이면 아무 흔적도 남기지 않음(메뉴·콘솔). 대화상자(DOM)는 브라우저 e2e 가 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collabLauncherPlugin, createErrorText, createRoom, ENCRYPTED_TEXT, inviteLinks, LAUNCHER_COMMAND, parseHealth, probeServer, takeCreateToken, TOO_SLOW_TEXT,
} from '../src/launcher.ts';

const json = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const memoryStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

test('서버 확인: 공동편집 서버의 답(ok + 아는 인증 방식)만 받는다, 그 밖은 조용히 null', async () => {
  assert.deepEqual(parseHealth({ ok: true, auth: 'hs256', encryptedAllowed: true }), { auth: 'hs256', encryptedAllowed: true });
  assert.deepEqual(parseHealth({ ok: true, auth: 'none' }), { auth: 'none', encryptedAllowed: false });
  for (const bad of [null, 'ok', { ok: true }, { ok: false, auth: 'none' }, { ok: true, auth: 'oauth' }]) assert.equal(parseHealth(bad), null, JSON.stringify(bad));
  const cases = [
    [() => json(200, { ok: true, auth: 'none' }), { auth: 'none', encryptedAllowed: false }],
    [() => json(404, 'Not Found', 'text/plain'), null],
    // 개발 서버의 SPA 대체 응답(index.html, 200)
    [() => json(200, '<!doctype html>', 'text/html'), null],
    [() => { throw new TypeError('network'); }, null],
    // 인증 방식을 알리지 않는 옛 서버
    [() => json(200, { ok: true }), null],
  ];
  for (const [respond, want] of cases) {
    const seen = [];
    const got = await probeServer(async (url) => { seen.push(url); return respond(); }, 'https://h.example');
    assert.deepEqual(got, want);
    assert.deepEqual(seen, ['https://h.example/healthz']);
  }
});

test('만들기 토큰: #create= 를 이 탭에 옮기고 주소에서 지운다(다른 조각은 그대로), 없으면 저장한 값', () => {
  const store = memoryStore();
  let replaced = null;
  assert.equal(takeCreateToken('#create=abc&x=1', store, (h) => { replaced = h; }), 'abc');
  assert.equal(replaced, '#x=1');
  assert.equal(store.m.get('collab-create-token'), 'abc');
  replaced = null;
  assert.equal(takeCreateToken('', store, (h) => { replaced = h; }), 'abc', '저장한 값');
  assert.equal(replaced, null, '조각이 없으면 주소를 건드리지 않음');
  assert.equal(takeCreateToken('#create=', memoryStore(), (h) => { replaced = h; }), null, '빈 값');
  assert.equal(replaced, '');
  // 초대 토큰(#token)은 만들기 토큰이 아니다
  assert.equal(takeCreateToken('#token=invite', memoryStore(), () => {}), null);
  // 저장소를 쓸 수 없어도 이번에는 쓴다
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} };
  assert.equal(takeCreateToken('#create=t', broken, () => {}), 't');
});

test('링크: 같은 출처 편집기 ?collab, 초대 토큰이 있으면 권한마다(편집·보기·양식 입력·메모), 없으면 #room 만', () => {
  const editor = 'https://h.example/';
  const links = inviteLinks(editor, { room: 'R1', invite: { view: 'tv', edit: 'te', comment: 'tc', form: 'tf' } });
  assert.deepEqual(links.map((l) => [l.scope, l.label]), [['edit', '편집'], ['view', '보기'], ['form', '양식 입력'], ['comment', '메모']]);
  assert.equal(links[0].url, 'https://h.example/?collab#token=te&room=R1');
  const none = inviteLinks(editor, { room: 'R2' });
  assert.deepEqual(none.map((l) => l.url), ['https://h.example/?collab#room=R2']);
  // 개발 서버: 편집기와 공동편집 서버가 다른 출처면 ws 주소를 싣는다
  assert.equal(inviteLinks('http://127.0.0.1:7700/', { room: 'R3' }, 'ws://127.0.0.1:8787/')[0].url, 'http://127.0.0.1:7700/?collab=ws%3A%2F%2F127.0.0.1%3A8787%2F#room=R3');
});

test('방 만들기: 201 이면 방, 실패는 사람이 읽는 말(권한·암호·크기·형식), 서버에 못 닿음', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let sent = null;
  const ok = await createRoom(async (url, init) => { sent = { url, init }; return json(201, { room: 'R', invite: { edit: 't' } }); }, 'https://h', bytes, 'CT');
  assert.deepEqual(ok, { ok: true, created: { room: 'R', invite: { edit: 't' } } });
  assert.equal(sent.url, 'https://h/rooms');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.authorization, 'Bearer CT');
  const noAuth = await createRoom(async (_u, init) => { sent = init; return json(201, { room: 'R' }); }, 'https://h', bytes, null);
  assert.equal(noAuth.ok, true);
  assert.equal('authorization' in sent.headers, false, '인증을 끈 서버는 토큰 없이');
  const fail = async (status, body) => (await createRoom(async () => json(status, body), 'https://h', bytes, 'CT')).text;
  assert.equal(await fail(400, { error: 'encrypted', message: '…' }), ENCRYPTED_TEXT);
  assert.match(await fail(401, { error: 'unauthorized', reason: 'missing' }), /create/);
  assert.match(await fail(403, { error: 'unauthorized', reason: 'scope' }), /create 권한 없음/);
  assert.match(await fail(413, { error: 'too-large' }), /너무 커서/);
  assert.match(await fail(415, { error: 'not-hwp' }), /열지 못해/);
  assert.match(createErrorText(500, { message: '서버 오류' }), /500: 서버 오류/);
  assert.equal(createErrorText(422, { error: 'too-slow', reason: 'too-slow' }), TOO_SLOW_TEXT, '여는 데 너무 오래 걸림');
  assert.equal(createErrorText(422, { error: 'invalid-document' }), '문서를 열지 못해 방을 만들 수 없습니다');
  const down = await createRoom(async () => { throw new TypeError('network'); }, 'https://h', bytes, null);
  assert.deepEqual(down, { ok: false, text: '서버에 닿지 못했습니다' });
});

/** 켜기: 최소 브라우저 전역 + 가짜 호스트 */
async function activateWith(fetchImpl, hash = '') {
  const registered = [];
  const menus = [];
  const logs = [];
  const original = { window: globalThis.window, history: globalThis.history, fetch: globalThis.fetch, error: console.error, warn: console.warn, log: console.log };
  globalThis.window = { location: { origin: 'https://h.example', pathname: '/', hash, search: '' }, sessionStorage: memoryStore() };
  globalThis.history = { state: null, replaceState: (_s, _t, url) => { globalThis.window.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } };
  globalThis.fetch = fetchImpl;
  console.error = console.warn = console.log = (...a) => logs.push(a);
  const host = {
    automation: { registerCommand: (def) => registered.push(def), addMenuItem: (spec) => menus.push(spec) },
    documentProtection: () => ({ requiresPasswordForSave: false }),
  };
  try {
    const surface = await collabLauncherPlugin.activate(host);
    return { surface, registered, menus, logs, location: globalThis.window.location };
  } finally {
    collabLauncherPlugin.deactivate();
    Object.assign(globalThis, { window: original.window, history: original.history, fetch: original.fetch });
    Object.assign(console, { error: original.error, warn: original.warn, log: original.log });
  }
}

test('켜기: 서버가 없거나(404·대체 HTML·네트워크 오류·옛 서버) url 방식이면 메뉴도 콘솔도 없다', async () => {
  for (const respond of [
    () => json(404, 'Not Found', 'text/plain'),
    () => json(200, '<!doctype html>', 'text/html'),
    () => { throw new TypeError('network'); },
    () => json(200, { ok: true }),
    () => json(200, { ok: true, auth: 'url' }),
  ]) {
    const got = await activateWith(async () => respond());
    assert.deepEqual([got.registered.length, got.menus.length, got.logs.length], [0, 0, 0]);
    assert.equal(got.surface.available(), false);
  }
});

test('켜기: none·hs256 이면 파일 메뉴에 "공동편집 시작…"(대화상자 명령), #create= 는 주소에서 지운다', async () => {
  for (const auth of ['none', 'hs256']) {
    const got = await activateWith(async () => json(200, { ok: true, auth, encryptedAllowed: false }), '#create=CT');
    assert.equal(got.registered.length, 1);
    assert.equal(got.registered[0].id, LAUNCHER_COMMAND);
    assert.equal(got.registered[0].opensDialog, true);
    assert.deepEqual(got.menus, [{ menuId: 'file', commandId: LAUNCHER_COMMAND, position: 'bottom' }]);
    assert.equal(got.location.hash, '', '만들기 토큰을 주소에서 지움');
    assert.equal(got.surface.auth(), auth);
    assert.deepEqual(got.logs, []);
  }
});

test('만든 사람의 이름: hs256 만들기 토큰의 name 을 읽어 들어가기 링크에만 싣는다(없거나 못 읽으면 null)', async () => {
  const { tokenName, withName } = await import('../src/launcher.ts');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
  assert.equal(tokenName(jwt({ sub: 'u', name: '김 담당', scope: 'create' })), '김 담당');
  assert.equal(tokenName(jwt({ sub: 'u', scope: 'create' })), null, '이름 없는 토큰');
  assert.equal(tokenName(jwt({ name: '  ' })), null);
  assert.equal(tokenName('not-a-jwt'), null);
  assert.equal(tokenName(null), null);
  for (const n of ['a', 'ab', 'abc', '가나다라마']) assert.equal(tokenName(jwt({ name: n })), n, `패딩 ${n}`);
  assert.equal(withName('https://x/?collab#token=t&room=r', '김 담당'), 'https://x/?collab#token=t&room=r&name=%EA%B9%80+%EB%8B%B4%EB%8B%B9');
  assert.equal(withName('https://x/?collab', 'A'), 'https://x/?collab#name=A');
  assert.equal(new URLSearchParams(withName('https://x/#room=r&name=old', 'new').split('#')[1]).get('name'), 'new');
});
