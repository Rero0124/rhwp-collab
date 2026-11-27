#!/usr/bin/env node
// HS256 토큰 발급 도구 (5단계 D1, 규약 docs/collab-protocol.md §2). 시험과 혼자·소규모 사용을 위한 것이다 —
// 바깥 시스템은 자기 JWT 라이브러리로 같은 클레임의 토큰을 만든다.
//
//   node server/token.mjs --new-secret                     32바이트 무작위 비밀키(base64url)를 찍는다
//   node server/token.mjs --room <방|*> [--scope "edit"] [--name 이름] [--sub 식별자] [--ttl 24h]
//
// 비밀키는 COLLAB_AUTH_SECRET 또는 COLLAB_AUTH_SECRET_FILE(또는 --secret-file)에서 읽는다(서버와 같은 변수).
// 토큰만 표준 출력에 찍는다. 비밀키·토큰을 저장소 안에 두지 않는다(공개 저장소).
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MIN_SECRET_BYTES, SCOPES, parseDuration, signHs256 } from './auth.mjs';

const usage = `쓰는 법:
  node server/token.mjs --new-secret
  node server/token.mjs --room <방|*> [--scope "edit"] [--name 이름] [--sub 식별자] [--ttl 24h] [--secret-file 경로]
권한(--scope, 공백으로 구분): ${SCOPES.join(', ')} — 없으면 edit`;

const { values } = parseArgs({
  options: {
    'new-secret': { type: 'boolean' },
    room: { type: 'string' },
    scope: { type: 'string' },
    name: { type: 'string' },
    sub: { type: 'string' },
    ttl: { type: 'string', default: '24h' },
    'secret-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const fail = (message) => { console.error(`token: ${message}\n${usage}`); process.exit(2); };

if (values.help) { console.log(usage); process.exit(0); }
if (values['new-secret']) {
  console.log(randomBytes(32).toString('base64url'));
  process.exit(0);
}
if (!values.room) fail('--room 이 필요합니다');

const file = values['secret-file'] ?? process.env.COLLAB_AUTH_SECRET_FILE;
const secret = process.env.COLLAB_AUTH_SECRET || (file ? readFileSync(file, 'utf8').replace(/\r?\n$/, '') : '');
if (!secret) fail('비밀키가 없습니다 (COLLAB_AUTH_SECRET 또는 COLLAB_AUTH_SECRET_FILE)');
if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) fail(`비밀키는 ${MIN_SECRET_BYTES}바이트 이상이어야 합니다`);

const scopes = values.scope ? values.scope.split(/\s+/).filter(Boolean) : [];
const unknown = scopes.filter((s) => !SCOPES.includes(s));
if (unknown.length) fail(`모르는 권한: ${unknown.join(', ')}`);

const now = Math.floor(Date.now() / 1000);
const claims = {
  sub: values.sub ?? (values.name ? `user:${values.name}` : `user:${randomBytes(4).toString('hex')}`),
  ...(values.name ? { name: values.name } : {}),
  room: values.room,
  ...(scopes.length ? { scope: scopes.join(' ') } : {}),
  iat: now,
  exp: now + parseDuration(values.ttl, 86_400),
};
console.log(signHs256(claims, secret));
