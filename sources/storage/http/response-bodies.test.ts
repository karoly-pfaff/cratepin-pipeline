import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineError } from '../../errors.ts';
import { discardControlBody, readControlText, readErrorPrefix } from './response-bodies.ts';

const LIMITS = { key: 'p/control', timeoutMs: 50 };

function watchedResponse(bytes: Uint8Array, isOpen: boolean) {
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (!isOpen) controller.close();
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { response: new Response(body), wasCancelled: () => wasCancelled };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof PipelineError && error.code === code;
}

test('a stalled response cancels its owned reader and releases the lock', async () => {
  const watched = watchedResponse(Buffer.from('<pending>'), true);
  await assert.rejects(readControlText(watched.response, LIMITS), hasCode('TRANSIENT_TRANSFER'));
  assert.equal(watched.wasCancelled(), true);
  assert.equal(watched.response.body?.locked, false);
});

test('an error prefix retains at most 16 KiB and cancels unread bytes even in one huge chunk', async () => {
  const watched = watchedResponse(Buffer.alloc(1024 * 1024, 120), true);
  assert.equal((await readErrorPrefix(watched.response, LIMITS)).length, 16_384);
  assert.equal(watched.wasCancelled(), true);
  assert.equal(watched.response.body?.locked, false);
});

test('control XML allows exactly 64 KiB and refuses larger bodies without echoing them', async () => {
  const boundary = watchedResponse(Buffer.alloc(65_536, 120), false);
  assert.equal((await readControlText(boundary.response, LIMITS)).length, 65_536);
  const oversized = watchedResponse(Buffer.alloc(65_537, 120), true);
  await assert.rejects(readControlText(oversized.response, { ...LIMITS, key: undefined }), {
    code: 'INVALID_DATA',
    details: { maxResponseBytes: 65_536 },
  });
  assert.equal(oversized.wasCancelled(), true);
  assert.equal(oversized.response.body?.locked, false);
});

test('unused bodies are drained without retained text and limited to 16 KiB', async () => {
  const boundary = watchedResponse(Buffer.alloc(16_384), false);
  await discardControlBody(boundary.response, LIMITS);
  assert.equal(boundary.response.body?.locked, false);
  const oversized = watchedResponse(Buffer.alloc(16_385), true);
  await assert.rejects(discardControlBody(oversized.response, LIMITS), hasCode('INVALID_DATA'));
  assert.equal(oversized.wasCancelled(), true);
});

test('an absent body is empty, and an aborted body keeps its error while releasing its reader', async () => {
  assert.equal(await readControlText(new Response(null, { status: 204 }), LIMITS), '');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new DOMException('private reason', 'AbortError'));
    },
  });
  const response = new Response(body);
  await assert.rejects(readControlText(response, LIMITS), { name: 'AbortError' });
  assert.equal(response.body?.locked, false);
});

test('cancellation while waiting for a control chunk releases the pending reader', async () => {
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort.signal.addEventListener(
        'abort',
        () => {
          controller.error(new DOMException('cancelled', 'AbortError'));
        },
        { once: true },
      );
    },
  });
  const response = new Response(body);
  const pending = readControlText(response, LIMITS);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(response.body?.locked, false);
});
