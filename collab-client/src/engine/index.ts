/** collab 엔진 공개 표면. studio·wasm 모듈을 import 하지 않는다. */
export { CollabEngine, type Entry, type EngineDoc, type EngineOptions, type ReceiveResult, type TextCaret } from './engine.ts';
export { classify, methodsToIntercept } from './classify.ts';
export { CATALOG, ENGINE_FINGERPRINT, COMPOSED_METHODS } from './catalog.ts';
export { bytesToBase64, base64ToBytes, encodeArgs, decodeArgs } from './codec.ts';
export type { CatalogEntry, Conc, Role, Sync } from './types.ts';
