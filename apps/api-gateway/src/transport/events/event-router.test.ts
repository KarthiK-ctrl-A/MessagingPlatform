import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Response } from 'express';
import type { MessageCreatedEvent } from '@messaging/contracts';
import { signPacket } from '@messaging/security';
import { EventRouter, type EventSink } from './event-router';
import { EventHub } from './event-hub.service';
import { EventsController, SseSink } from '../http/events.controller';
import type { ActorRequest } from '../../security/auth.guard';

const doctor = randomUUID();
const patient = randomUUID();
const outsider = randomUUID();

function event(overrides: Partial<MessageCreatedEvent> = {}): MessageCreatedEvent {
  const now = Date.now();
  return {
    audience: 'api-gateway', type: 'message.created', eventId: randomUUID(), messageId: randomUUID(),
    conversationId: randomUUID(), participants: [doctor, patient], occurredAt: new Date().toISOString(),
    issuedAt: now, expiresAt: now + 30000, ...overrides,
  };
}

class RecordingSink implements EventSink {
  readonly events: { event: string; data: unknown; id?: string }[] = [];
  closed = false;
  send(event: string, data: unknown, id?: string) { this.events.push({ event, data, id }); }
  close() { this.closed = true; }
}

test('events reach only the participants\' streams, without message content', () => {
  const router = new EventRouter({ perUser: 5, total: 100, dedupeWindow: 100 });
  const [doctorTab1, doctorTab2, patientTab, outsiderTab] = [new RecordingSink(), new RecordingSink(), new RecordingSink(), new RecordingSink()];
  router.register(doctor, doctorTab1);
  router.register(doctor, doctorTab2);
  router.register(patient, patientTab);
  router.register(outsider, outsiderTab);
  const created = event();
  assert.equal(router.deliver(created), 3);
  assert.equal(outsiderTab.events.length, 0);
  assert.deepEqual(patientTab.events[0], { event: 'message-created', id: created.eventId, data: {
    eventId: created.eventId, conversationId: created.conversationId, messageId: created.messageId, occurredAt: created.occurredAt,
  } });
});

test('a republished event is delivered once', () => {
  const router = new EventRouter({ perUser: 5, total: 100, dedupeWindow: 2 });
  const sink = new RecordingSink();
  router.register(patient, sink);
  const first = event();
  assert.equal(router.deliver(first), 1);
  assert.equal(router.deliver(first), 0);
  router.deliver(event());
  router.deliver(event()); // pushes `first` out of the bounded window
  assert.equal(sink.events.length, 3);
});

test('connection limits apply per user and in total, and unregistering frees a slot', () => {
  const router = new EventRouter({ perUser: 2, total: 3, dedupeWindow: 10 });
  const release = router.register(patient, new RecordingSink());
  router.register(patient, new RecordingSink());
  assert.throws(() => router.register(patient, new RecordingSink()), (error: { getStatus(): number }) => error.getStatus() === 429);
  router.register(doctor, new RecordingSink());
  assert.throws(() => router.register(outsider, new RecordingSink()), (error: { getStatus(): number }) => error.getStatus() === 503);
  release();
  release(); // idempotent
  assert.equal(router.connections, 2);
  assert.doesNotThrow(() => router.register(outsider, new RecordingSink()));
});

test('the hub accepts only fresh events signed by the messaging service', () => {
  const b = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  process.env.B_PUBLIC_KEY = b.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const bPrivate = b.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const forger = other.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const hub = new EventHub();
  const valid = event();
  assert.deepEqual(hub.parse(JSON.stringify(signPacket(valid, bPrivate))), valid);
  assert.equal(hub.parse(JSON.stringify(signPacket(event(), forger))), undefined);
  assert.equal(hub.parse(JSON.stringify(signPacket(event({ issuedAt: Date.now() - 60000, expiresAt: Date.now() - 30000 }), bPrivate))), undefined);
  assert.equal(hub.parse(JSON.stringify(signPacket({ ...event(), content: 'secret' }, bPrivate))), undefined);
  assert.equal(hub.parse('not json'), undefined);
});

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  writableEnded = false;
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; this.emit('close'); }
}

test('the stream sends SSE frames, ends at token expiry, and releases its slot', async () => {
  const hub = new EventHub();
  (hub as unknown as { state: string }).state = 'connected';
  const res = new FakeResponse();
  const req = { actor: { id: patient, accessToken: 'x', requestId: 'r', expiresAt: Math.floor(Date.now() / 1000) } } as unknown as ActorRequest;
  new EventsController(hub).stream(req, res as unknown as Response);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(hub.router.connections, 1);
  hub.router.deliver(event({ participants: [patient, doctor] }));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const output = res.chunks.join('');
  assert.match(output, /^retry: 5000\n\nevent: ready\ndata: /);
  assert.match(output, /id: [0-9a-f-]{36}\nevent: message-created\ndata: \{"eventId"/);
  assert.match(output, /event: session-expired/);
  assert.equal(res.writableEnded, true);
  assert.equal(hub.router.connections, 0);
});

test('a closed response ignores further writes', () => {
  const res = new FakeResponse();
  const sink = new SseSink(res as unknown as Response);
  sink.close();
  sink.send('message-created', {});
  sink.comment('ping');
  assert.deepEqual(res.chunks, []);
});

test('streams are refused while live events are unavailable, so clients fall back to polling', () => {
  const hub = new EventHub();
  for (const state of ['starting', 'disconnected', 'forbidden', 'failed']) {
    (hub as unknown as { state: string }).state = state;
    const req = { actor: { id: patient, accessToken: 'x' } } as unknown as ActorRequest;
    assert.throws(() => new EventsController(hub).stream(req, new FakeResponse() as unknown as Response),
      (error: { getStatus(): number }) => error.getStatus() === 503);
  }
  assert.equal(hub.router.connections, 0);
});
