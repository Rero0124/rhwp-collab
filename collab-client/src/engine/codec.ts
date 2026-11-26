/**
 * 기록 인코딩 (docs/collab-stage2.md §3 기록 형태). studio·wasm 을 모른다.
 *
 * export 인자는 `number`·`string`·`boolean`·`Uint8Array`·`null`(·`undefined`) 뿐이다. `Uint8Array` 는
 * `{"$b64":"..."}` 로 감싸 JSON 으로 보낸다.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 기록할 수 없는 인자(다른 문서 객체 등)를 만나면 던진다 — 호출자는 그 기록을 `state` 로 바꾼다. */
export class UnencodableArgument extends Error {}

export function encodeArgs(args: readonly unknown[]): unknown[] {
  return args.map((v, i) => {
    if (v instanceof Uint8Array) return { $b64: bytesToBase64(v) };
    if (v === undefined || v === null) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    throw new UnencodableArgument(`인자 ${i} 를 기록할 수 없습니다 (${typeof v})`);
  });
}

export function decodeArgs(args: readonly unknown[]): unknown[] {
  return args.map((v) => {
    if (v && typeof v === 'object' && typeof (v as { $b64?: unknown }).$b64 === 'string') {
      return base64ToBytes((v as { $b64: string }).$b64);
    }
    return v === null ? undefined : v;
  });
}
