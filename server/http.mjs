// 공동편집 서버의 HTTP 쪽 (5단계 D2·D3, 규약 docs/collab-protocol.md §5).
//
//   POST /rooms                  본문 = HWP/HWPX 바이트 → 201 {room, invite?, inviteExpiresAt?}
//   GET  /rooms/{room}/document  → 200 최신 문서 파일(원본 형식)
//   GET  /upload                 업로드 페이지(server/public/upload.html)
//   GET  /healthz                → 200 {ok, auth, encryptedAllowed}
//   GET  그 밖                    staticDir 의 정적 파일(빌드한 studio). 없으면 404
//
// 인증·방 처리는 server.mjs 가 넘기는 api 가 한다. 여기서는 경로, 본문 상한, 오류 응답, 정적 파일만 다룬다.
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthError } from './auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_PAGE = path.join(here, 'public', 'upload.html');

export class HttpError extends Error {
  constructor(status, code, message = code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** 인증 실패 → HTTP 상태. 401 은 토큰을 다시 받으면 될 수 있는 것, 403 은 권한, 404 는 방이 없음. */
const AUTH_STATUS = { missing: 401, invalid: 401, expired: 401, room: 403, scope: 403, 'no-room': 404, unavailable: 503 };

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

const sendJson = (res, status, body, headers = {}) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', ...headers });
  res.end(data);
};

const sendError = (res, error) => {
  if (error instanceof AuthError) {
    return sendJson(res, AUTH_STATUS[error.reason] ?? 401, { error: 'unauthorized', reason: error.reason }, error.reason === 'missing' ? { 'www-authenticate': 'Bearer' } : {});
  }
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.code, message: error.message, ...error.extra });
  return sendJson(res, 500, { error: 'internal', message: '서버 오류' });
};

/** 본문을 상한까지 읽는다. 넘으면 413 — 다 읽지 않고 끊는다. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new HttpError(413, 'too-large', `본문이 상한 ${limit}바이트를 넘는다`, { limit }));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'too-large', `본문이 상한 ${limit}바이트를 넘는다`, { limit }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * staticDir 안의 파일로만 푼다(경로 탈출 거절). 디렉터리면 index.html. 없으면 null.
 * @returns {Promise<{file: string, stat: import('node:fs').Stats} | null>}
 */
export async function resolveStatic(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const base = path.resolve(root);
  let file = path.resolve(base, `.${path.posix.normalize(`/${decoded}`)}`);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  try {
    let stat = await fs.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.stat(file);
    }
    if (!stat.isFile()) return null;
    // 심볼릭 링크로 밖을 가리키는 경우도 막는다.
    const real = await fs.realpath(file);
    const realBase = await fs.realpath(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
    return { file, stat };
  } catch {
    return null;
  }
}

/** 정적 파일 응답. 해시가 붙은 assets/ 는 오래 캐시하고, 그 밖(index.html 등)은 매번 확인한다. */
function serveFile(req, res, { file, stat }, { cache, headers: extraHeaders = {} } = {}) {
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cache ?? 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/**
 * @param {{
 *   api: { createRoom(req: import('node:http').IncomingMessage, body: Buffer): Promise<object>,
 *          download(req: import('node:http').IncomingMessage, room: string): Promise<{raw: Buffer, format: string, seq: number, encrypted?: boolean}> },
 *   staticDir?: string|null, maxBodyBytes: number, originAllowed(req): boolean, log(m: string): void,
 * }} opts
 */
/** 6단계 S3: 부품 전용 모드에서 최상위로 연 편집기 요청에 주는 안내 페이지 */
const EMBED_ONLY_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>공동편집</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.6 system-ui,sans-serif;background:#f6f7f9;color:#1d2330}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#e6e9ef}}main{max-width:520px;padding:24px 16px;text-align:center}</style></head>
<body><main><h1 style="font-size:20px">이 편집기는 연결된 시스템 안에서만 열 수 있습니다</h1><p>문서를 연 시스템의 화면으로 돌아가 다시 열어 주세요.</p></main></body></html>`;

/**
 * @param {object} opts
 * @param {null | { origins: string[] }} [opts.embedOnly] 6단계 S3 부품 전용 모드: 편집기 HTML 에 CSP frame-ancestors, 최상위
 *   탐색(Sec-Fetch-Dest: document)은 403 안내 페이지, 업로드 페이지 끔
 */
export function createHttpHandler({ api, staticDir = null, maxBodyBytes, originAllowed, log, health = () => ({}), embedOnly = null }) {
  const frameAncestors = embedOnly ? { 'content-security-policy': `frame-ancestors ${embedOnly.origins.join(' ')}` } : {};
  return async (req, res) => {
    let url;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch { return sendJson(res, 400, { error: 'bad-url' }); }
    const { pathname } = url;
    try {
      if (pathname === '/rooms') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' }, { allow: 'POST' });
        if (!originAllowed(req)) return sendJson(res, 403, { error: 'origin' });
        const body = await readBody(req, maxBodyBytes);
        const out = await api.createRoom(req, body);
        return sendJson(res, 201, out);
      }
      const doc = /^\/rooms\/([^/]+)\/document$/.exec(pathname);
      if (doc) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' }, { allow: 'GET' });
        let room;
        try { room = decodeURIComponent(doc[1]); } catch { return sendJson(res, 400, { error: 'bad-url' }); }
        const { raw, format, seq, encrypted } = await api.download(req, room);
        res.writeHead(200, {
          // 7단계 C: 요청 머리의 암호를 걸어 내보낸 파일
          ...(encrypted ? { 'x-collab-encrypted': '1' } : {}),
          'content-type': 'application/octet-stream',
          'content-length': raw.length,
          'content-disposition': `attachment; filename="document.${format}"`,
          'cache-control': 'no-store',
          'x-collab-seq': String(seq),
          'x-content-type-options': 'nosniff',
        });
        return res.end(req.method === 'HEAD' ? undefined : raw);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method' }, { allow: 'GET, HEAD' });
      // 서버 상태와 설정 요약(비밀이 아닌 것만) — studio 의 공동편집 시작 메뉴가 메뉴를 보일지·토큰이 필요한지 정한다
      // 비밀이 아니므로 다른 출처(개발용 편집기 서버 등)에서도 읽게 둔다 — 쿠키 없이, 읽기만
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true, ...health() }, { 'access-control-allow-origin': '*' });
      if ((pathname === '/upload' || pathname === '/upload.html') && !embedOnly) {
        const stat = await fs.stat(UPLOAD_PAGE);
        return serveFile(req, res, { file: UPLOAD_PAGE, stat });
      }
      if (staticDir) {
        const found = await resolveStatic(staticDir, pathname);
        if (found) {
          const html = found.file.endsWith('.html');
          // S3: 부품 전용 모드의 편집기 문서는 허용된 부모의 iframe 안에서만. 최상위로 열면 안내 페이지(Sec-Fetch 를 보내지 않는
          // 오래된 브라우저는 frame-ancestors 와 플러그인의 최상위 창 확인이 막는다).
          if (embedOnly && html && req.headers['sec-fetch-dest'] === 'document') {
            const body = Buffer.from(EMBED_ONLY_PAGE);
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            return res.end(req.method === 'HEAD' ? undefined : body);
          }
          return serveFile(req, res, found, {
            cache: pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
            headers: html ? frameAncestors : {},
          });
        }
      }
      return sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof AuthError)) log(`HTTP ${req.method} ${pathname} 오류: ${error?.stack ?? error}`);
      if (res.headersSent) return res.destroy();
      return sendError(res, error);
    }
  };
}
