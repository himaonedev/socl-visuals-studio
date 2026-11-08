// Generated from backend/engine/contracts.ts by scripts/backend.cjs. Edit the TypeScript source.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRequest = parseRequest;
exports.errorMessage = errorMessage;
/** Validate external JSON before calling a legacy operation. */
function parseRequest(value) {
    if (!value || typeof value !== 'object')
        throw new Error('Invalid engine request');
    const input = value;
    if (input.kind === 'shutdown')
        return { kind: 'shutdown' };
    if (!Number.isSafeInteger(input.id) || input.id < 0)
        throw new Error('Invalid request id');
    const id = input.id;
    if (input.kind === 'native-progress')
        return { kind: 'native-progress', id, data: input.data };
    if (input.kind === 'native-result') {
        if (input.error !== undefined && input.error !== null && typeof input.error !== 'string')
            throw new Error('Invalid native error');
        return { kind: 'native-result', id, result: input.result, error: typeof input.error === 'string' ? input.error : undefined };
    }
    if (input.kind !== undefined && input.kind !== 'invoke')
        throw new Error('Invalid request kind');
    if (typeof input.channel !== 'string' || !input.channel.trim())
        throw new Error('Invalid engine channel');
    if (input.args !== undefined && !Array.isArray(input.args))
        throw new Error('Invalid engine arguments');
    return { kind: 'invoke', id, channel: input.channel, args: (input.args || []) };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
