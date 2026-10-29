#!/usr/bin/env node
// A minimal stand-in for the Anthropic Messages API, for tests only.
//
//   node fake-model-api.mjs --listen <host:port> --log <file>
//
// Every request is appended to the log as one JSON line — method, path and the
// credential headers it arrived with — so a test can prove which key reached the
// upstream. Answers:
//   * POST /v1/messages, non-streaming: a JSON message (plus the sha256 of the
//     x-api-key it saw, so an agent can report it without ever holding it);
//   * POST /v1/messages, streaming: the real SSE sequence. On the first turn of
//     a prompt that names a work order file, it asks for a Read of that file;
//     otherwise it answers with text;
//   * anything else: 404.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import http from 'node:http';

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) {
    process.stderr.write(`fake-model-api: missing ${name}\n`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const listen = arg('--listen');
const logFile = arg('--log');
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sha256 = (s) => createHash('sha256').update(s ?? '').digest('hex');

function promptText(body) {
  const first = body.messages?.[0];
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return (first.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    appendFileSync(logFile, `${JSON.stringify({
      at: Date.now(), method: req.method, path: req.url,
      apiKey: req.headers['x-api-key'] ?? null, authorization: req.headers['authorization'] ?? null,
    })}\n`);
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch { /* treated as empty */ }
    const model = body.model ?? 'claude-fake';
    const msg = {
      id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 },
    };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ...msg, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 3 }, sawKeySha256: sha256(req.headers['x-api-key']),
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', { type: 'message_start', message: msg });
    const wo = /Your work order is (\S+) \(sha256/.exec(promptText(body));
    if (wo && (body.messages ?? []).length === 1) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake1', name: 'Read', input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: wo[1] }) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
});

const sep = listen.lastIndexOf(':');
server.listen(Number(listen.slice(sep + 1)), listen.slice(0, sep), () => {
  appendFileSync(logFile, `${JSON.stringify({ listening: server.address().port })}\n`);
  process.stdout.write(`fake-model-api listening ${server.address().port}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
