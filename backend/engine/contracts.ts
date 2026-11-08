export type InvokeRequest = { kind?: 'invoke'; id: number; channel: string; args: unknown[] };
export type NativeResult = { kind: 'native-result'; id: number; result?: unknown; error?: string };
export type EngineRequest = InvokeRequest | NativeResult | { kind: 'native-progress'; id: number; data: unknown } | { kind: 'shutdown' };

/** Validate external JSON before calling a legacy operation. */
export function parseRequest(value: unknown): EngineRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid engine request');
  const input = value as Record<string, unknown>;
  if (input.kind === 'shutdown') return { kind: 'shutdown' };
  if (!Number.isSafeInteger(input.id) || (input.id as number) < 0) throw new Error('Invalid request id');
  const id = input.id as number;
  if (input.kind === 'native-progress') return { kind: 'native-progress', id, data: input.data };
  if (input.kind === 'native-result') {
    if (input.error !== undefined && input.error !== null && typeof input.error !== 'string') throw new Error('Invalid native error');
    return { kind: 'native-result', id, result: input.result, error: typeof input.error === 'string' ? input.error : undefined };
  }
  if (input.kind !== undefined && input.kind !== 'invoke') throw new Error('Invalid request kind');
  if (typeof input.channel !== 'string' || !input.channel.trim()) throw new Error('Invalid engine channel');
  if (input.args !== undefined && !Array.isArray(input.args)) throw new Error('Invalid engine arguments');
  return { kind: 'invoke', id, channel: input.channel, args: (input.args || []) as unknown[] };
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export interface MediaTransport {
  grant(value: unknown, root?: boolean): void;
  grantValue(value: unknown): void;
  close(): void;
  listen?(): Promise<string>;
}
export interface PlatformBridge {
  handlers: Map<string, (event: { sender: PlatformBridge['sender'] }, ...args: unknown[]) => unknown>;
  sender: { send(channel: string, data: unknown): void; isDestroyed(): boolean };
  connect(send: (channel: string, data: unknown) => void, request: (op: string, payload: unknown, progress?: (value: unknown) => void) => Promise<unknown>): void;
}
export interface ClippingEngine {
  outputRoot: string;
  readCfg(): { workRoots?: string[]; exportPath?: string };
  requestPipelineCancel(): void;
}
