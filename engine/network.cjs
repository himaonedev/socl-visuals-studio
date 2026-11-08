// Generated from backend/engine/network.ts by scripts/backend.cjs. Edit the TypeScript source.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.request = request;
// Streaming network facade for transitional modules that previously used Electron net.
const node_events_1 = require("node:events");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
let trustedCertificates;
function systemTrust() {
    if (trustedCertificates !== undefined)
        return trustedCertificates;
    try {
        if (typeof tls.getCACertificates === 'function') {
            trustedCertificates = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
        }
    }
    catch { }
    return trustedCertificates;
}
function request(input) {
    const options = typeof input === 'string' ? { url: input } : { ...input };
    const output = new node_events_1.EventEmitter();
    const headers = { ...options.headers };
    const chunks = [];
    let active, response, started = false, aborted = false;
    const fail = (error) => { if (!aborted)
        output.emit('error', error); };
    output.setHeader = (name, value) => {
        if (started)
            throw new Error('Headers cannot be changed after request.end()');
        headers[name] = value;
    };
    output.getHeader = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    output.removeHeader = name => { for (const key of Object.keys(headers))
        if (key.toLowerCase() === name.toLowerCase())
            delete headers[key]; };
    output.write = chunk => { if (started)
        throw new Error('Request has already ended'); chunks.push(Buffer.from(chunk)); return true; };
    output.abort = () => { aborted = true; active?.destroy(); response?.destroy(); };
    output.destroy = error => { active?.destroy(error); response?.destroy(error); if (!active && error)
        queueMicrotask(() => fail(error)); };
    function dispatch(current, method, remaining, currentHeaders, body) {
        if (aborted)
            return;
        let url;
        try {
            url = new URL(current);
            if (!['http:', 'https:'].includes(url.protocol))
                throw new Error('Only HTTP(S) requests are supported');
            const client = url.protocol === 'https:' ? https : http;
            active = client.request(url, { method, headers: currentHeaders, ...(url.protocol === 'https:' && systemTrust() ? { ca: systemTrust() } : {}) }, incoming => {
                response = incoming;
                if ([301, 302, 303, 307, 308].includes(incoming.statusCode || 0) && incoming.headers.location) {
                    incoming.resume();
                    let next;
                    try {
                        next = new URL(incoming.headers.location, url).href;
                    }
                    catch (error) {
                        fail(error);
                        return;
                    }
                    if (options.redirect === 'manual') {
                        output.emit('redirect', incoming.statusCode, method, next, incoming.headers);
                        return;
                    }
                    if (options.redirect === 'error') {
                        fail(new Error('Request was redirected'));
                        return;
                    }
                    if (remaining === 0) {
                        fail(new Error('Too many download redirects'));
                        return;
                    }
                    if (url.protocol === 'https:' && new URL(next).protocol !== 'https:') {
                        fail(new Error('Refusing HTTPS downgrade redirect'));
                        return;
                    }
                    const nextHeaders = { ...currentHeaders };
                    if (new URL(next).origin !== url.origin)
                        for (const key of Object.keys(nextHeaders)) {
                            if (['authorization', 'cookie', 'host'].includes(key.toLowerCase()))
                                delete nextHeaders[key];
                        }
                    const useGet = incoming.statusCode === 303 || ([301, 302].includes(incoming.statusCode || 0) && method === 'POST');
                    if (useGet)
                        for (const key of Object.keys(nextHeaders))
                            if (['content-length', 'content-type'].includes(key.toLowerCase()))
                                delete nextHeaders[key];
                    dispatch(next, useGet ? 'GET' : method, remaining - 1, nextHeaders, useGet ? null : body);
                    return;
                }
                output.emit('response', incoming);
            });
            active.on('error', fail);
            active.end(body);
        }
        catch (error) {
            queueMicrotask(() => fail(error));
        }
    }
    output.end = chunk => {
        if (started)
            throw new Error('Request has already ended');
        if (chunk != null)
            chunks.push(Buffer.from(chunk));
        started = true;
        dispatch(options.url, String(options.method || 'GET').toUpperCase(), 10, headers, chunks.length ? Buffer.concat(chunks) : null);
        return output;
    };
    return output;
}
module.exports = { request };
