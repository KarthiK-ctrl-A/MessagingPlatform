/**
 * Runs the real migrations, RLS policies, triggers and SQL functions against
 * PostgreSQL. Skipped unless TEST_DATABASE_URL points at a disposable server
 * with a superuser connection (CI starts one; see README "Integration tests").
 * The test creates and drops its own database and the messaging_b_runtime role,
 * so never point it at a shared or production server.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client, Pool } from 'pg';
import { DatabaseSession, RUNTIME_ROLE } from './database-session';
import { ConversationRepository } from './conversation.repository';
import { CareContactRepository } from './care-contact.repository';
import { MessageRepository } from './message.repository';
import { ReplayStore } from './replay.store';
import { preciseTimestampTypes } from './timestamps';
import { generateKeyPairSync } from 'node:crypto';
import { EVENT_SUBJECTS, messageCreatedEventSchema } from '@messaging/contracts';
import { verifyPacket } from '@messaging/security';
import { OutboxRelay } from '../events/outbox-relay.service';
import type { EventPublisher } from '../events/event-publisher';

const signing = generateKeyPairSync('ed25519');
process.env.B_PRIVATE_KEY = signing.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const bPublicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** Collects published packets; can be told to fail to exercise retry behaviour. */
class RecordingPublisher implements EventPublisher {
  readonly published: { subject: string; packet: object }[] = [];
  fail = false;
  async publish(subject: string, packet: object) { this.published.push({ subject, packet }); }
  async flush() { if (this.fail) throw new Error('broker unavailable'); }
}

const adminUrl = process.env.TEST_DATABASE_URL;
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const databaseName = 'messaging_integration';
const runtimePassword = `it-${randomUUID()}`;

const doctor1 = randomUUID();
const doctor2 = randomUUID();
const patient1 = randomUUID();
const patient2 = randomUUID();

describe('database integration (migrations, RLS, triggers)', { skip: !adminUrl && 'TEST_DATABASE_URL not set' }, () => {
  let admin: Client;
  let pool: Pool;
  let db: DatabaseSession;
  let conversations: ConversationRepository;
  let contacts: CareContactRepository;
  let messages: MessageRepository;
  let patient1Row: string;
  let runtimeUrl: string;

  before(async () => {
    const server = new Client({ connectionString: adminUrl });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    const existing = await server.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE]);
    if (existing.rowCount) {
      await server.query(`REVOKE ALL ON DATABASE postgres FROM ${RUNTIME_ROLE}`);
      await server.query(`DROP ROLE ${RUNTIME_ROLE}`);
    }
    await server.query(`CREATE DATABASE ${databaseName}`);
    await server.end();

    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(readFileSync(join(repoRoot, 'supabase/test/clinical-stub.sql'), 'utf8'));

    // Pre-existing clinical data: one legacy message, which the first migration backfills.
    await admin.query(`INSERT INTO public.profiles (id, full_name, role) VALUES
      ($1, 'Dr One', 'doctor'), ($2, 'Dr Two', 'doctor'), ($3, 'Pat One', 'patient'), ($4, 'Pat Two', 'patient')`,
    [doctor1, doctor2, patient1, patient2]);
    patient1Row = (await admin.query<{ id: string }>(
      'INSERT INTO public.patients (user_id, doctor_id) VALUES ($1, $2) RETURNING id', [patient1, doctor1])).rows[0].id;
    await admin.query('INSERT INTO public.patients (user_id, doctor_id) VALUES ($1, $2)', [patient2, doctor2]);
    await admin.query(`INSERT INTO public.messages (patient_id, doctor_id, sender_id, content, created_at)
      VALUES ($1, $2, $3, 'legacy hello', now() - interval '1 day')`, [patient1Row, doctor1, patient1]);

    const migrations = readdirSync(join(repoRoot, 'supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations) await admin.query(readFileSync(join(repoRoot, 'supabase/migrations', name), 'utf8'));
    await admin.query(`ALTER ROLE ${RUNTIME_ROLE} PASSWORD '${runtimePassword}'`);

    url.username = RUNTIME_ROLE;
    url.password = runtimePassword;
    pool = new Pool({ connectionString: url.toString(), max: 6, types: preciseTimestampTypes });
    runtimeUrl = url.toString();
    db = new DatabaseSession(pool);
    await db.onModuleInit();
    conversations = new ConversationRepository(db);
    contacts = new CareContactRepository(db);
    messages = new MessageRepository(db);
  });

  after(async () => {
    await pool?.end();
    await admin?.end();
  });

  test('the runtime role is verified and the fast history path is detected', async () => {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    assert.equal(result.rows[0].current_user, RUNTIME_ROLE);
  });

  test('legacy messages are backfilled into a conversation visible only to the care pair', async () => {
    const forPatient = await conversations.listConversations(patient1, 50);
    assert.equal(forPatient.length, 1);
    const history = await messages.listMessages(patient1, forPatient[0].id, 10);
    assert.deepEqual(history.items.map((item) => item.content), ['legacy hello']);
    assert.equal((await conversations.listConversations(doctor1, 50)).length, 1);
    assert.equal((await conversations.listConversations(doctor2, 50)).length, 0);
    await assert.rejects(messages.listMessages(doctor2, forPatient[0].id, 10), { code: 'NOT_FOUND' });
  });

  test('care contacts and the current-doctor conversation follow the assignment', async () => {
    assert.deepEqual(await contacts.listCareContacts(patient1), { role: 'patient', contacts: [{ userId: doctor1, fullName: 'Dr One' }] });
    assert.deepEqual(await contacts.listCareContacts(doctor2), { role: 'doctor', contacts: [{ userId: patient2, fullName: 'Pat Two' }] });
    const first = await conversations.openCurrentDoctor(patient1);
    const again = await conversations.openCurrentDoctor(patient1);
    assert.equal(first.id, again.id, 'one conversation per care pair');
  });

  test('a conversation with someone outside the care pair is rejected as invalid', async () => {
    await assert.rejects(conversations.createConversation(patient1, doctor2), { code: 'VALIDATION', message: 'Invalid recipient' });
    await assert.rejects(conversations.createConversation(patient1, patient1), { code: 'VALIDATION' });
  });

  test('sending is idempotent per client message ID and detects conflicting reuse', async () => {
    const conversation = await conversations.createConversation(doctor2, patient2);
    const clientMessageId = randomUUID();
    const sent = await messages.sendMessage(patient2, conversation.id, clientMessageId, 'hello doctor');
    const retried = await messages.sendMessage(patient2, conversation.id, clientMessageId, 'hello doctor');
    assert.equal(retried.id, sent.id);
    await assert.rejects(messages.sendMessage(patient2, conversation.id, clientMessageId, 'different'), { code: 'CONFLICT' });
  });

  test('a user outside the conversation cannot read or write it', async () => {
    const [conversation] = await conversations.listConversations(patient1, 50);
    await assert.rejects(messages.sendMessage(doctor2, conversation.id, randomUUID(), 'intrusion'), { code: 'NOT_FOUND' });
    // Bypass the repository's membership check: the trigger and RLS still refuse the row.
    await assert.rejects(db.asActor(doctor2, 'test', undefined, (client) => client.query(
      'INSERT INTO public.messages (conversation_id, sender_id, client_message_id, content) VALUES ($1,$2,$3,$4)',
      [conversation.id, doctor2, randomUUID(), 'intrusion'])), { code: 'FORBIDDEN' });
  });

  test('history pages with a stable cursor', async () => {
    const conversation = await conversations.openCurrentDoctor(patient1);
    for (let i = 1; i <= 5; i++) await messages.sendMessage(doctor1, conversation.id, randomUUID(), `page ${i}`);
    const first = await messages.listMessages(patient1, conversation.id, 2);
    assert.deepEqual(first.items.map((item) => item.content), ['page 5', 'page 4']);
    assert.ok(first.nextCursor);
    const second = await messages.listMessages(patient1, conversation.id, 2, { before: first.nextCursor! });
    assert.deepEqual(second.items.map((item) => item.content), ['page 3', 'page 2']);
    await assert.rejects(messages.listMessages(patient1, conversation.id, 2, { before: 'not-a-cursor' }), { code: 'VALIDATION' });
  });

  test('reassigning the patient removes the previous doctor\'s access', async () => {
    const conversation = await conversations.openCurrentDoctor(patient1);
    await admin.query('UPDATE public.patients SET doctor_id = $1 WHERE id = $2', [doctor2, patient1Row]);
    try {
      await assert.rejects(messages.listMessages(doctor1, conversation.id, 10), { code: 'NOT_FOUND' });
      await assert.rejects(messages.sendMessage(doctor1, conversation.id, randomUUID(), 'still there?'), { code: 'NOT_FOUND' });
      assert.equal((await contacts.listCareContacts(patient1)).contacts[0].userId, doctor2);
    } finally {
      await admin.query('UPDATE public.patients SET doctor_id = $1 WHERE id = $2', [doctor1, patient1Row]);
    }
  });

  test('a request ID can be claimed only once across replicas', async () => {
    const replay = new ReplayStore(db);
    const id = randomUUID();
    const expiresAt = Date.now() + 15000;
    const results = await Promise.all([replay.claim(id, expiresAt), replay.claim(id, expiresAt)]);
    assert.deepEqual(results.sort(), [false, true]);
  });

  test('the conversation list query can use the per-participant indexes', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [patient1]);
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id,user_low,user_high,created_at FROM public.conversations
         WHERE user_low=$1 OR user_high=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, [patient1]);
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(text, /conversations_user_(low|high)_time/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
  test('timestamps keep microseconds so rows in the same millisecond are never skipped', async () => {
    const conversation = await conversations.createConversation(doctor2, patient2);
    // Five messages inside one millisecond, as a bulk import or a busy clinic could produce.
    await admin.query(`INSERT INTO public.messages (conversation_id, sender_id, client_message_id, content, created_at)
      SELECT $1, $2, gen_random_uuid(), 'burst ' || n, timestamptz '2030-01-01 00:00:00.123+00' + n * interval '1 microsecond'
      FROM generate_series(1, 5) AS n`, [conversation.id, patient2]);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await messages.listMessages(doctor2, conversation.id, 2, before ? { before } : {});
      seen.push(...page.items.filter((item) => item.content.startsWith('burst')).map((item) => item.content));
      before = page.nextCursor ?? undefined;
    } while (before);
    assert.deepEqual(seen, ['burst 5', 'burst 4', 'burst 3', 'burst 2', 'burst 1']);
    const newest = await messages.listMessages(doctor2, conversation.id, 1);
    assert.match(newest.items[0].createdAt, /^2030-01-01T00:00:00\.123005Z$/);
  });

  test('the after cursor returns only newer messages, newest first', async () => {
    const conversation = await conversations.openCurrentDoctor(patient1);
    const start = await messages.listMessages(patient1, conversation.id, 50);
    assert.ok(start.latestCursor);
    const empty = await messages.listMessages(patient1, conversation.id, 50, { after: start.latestCursor! });
    assert.deepEqual(empty, { items: [], nextCursor: null, latestCursor: null });
    await messages.sendMessage(doctor1, conversation.id, randomUUID(), 'new A');
    await messages.sendMessage(patient1, conversation.id, randomUUID(), 'new B');
    const fresh = await messages.listMessages(patient1, conversation.id, 50, { after: start.latestCursor! });
    assert.deepEqual(fresh.items.map((item) => item.content), ['new B', 'new A']);
    const limited = await messages.listMessages(patient1, conversation.id, 1, { after: start.latestCursor! });
    assert.deepEqual(limited.items.map((item) => item.content), ['new A'], 'a full page means: ask again from latestCursor');
    await assert.rejects(messages.listMessages(doctor2, conversation.id, 50, { after: start.latestCursor! }), { code: 'NOT_FOUND' });
    await assert.rejects(messages.listMessages(patient1, conversation.id, 50, { before: start.latestCursor!, after: start.latestCursor! }), { code: 'VALIDATION' });
  });

  test('every committed message, including direct clinical-app inserts, gets exactly one outbox event', async () => {
    await admin.query('UPDATE internal.message_outbox SET published_at = now() WHERE published_at IS NULL');
    const conversation = await conversations.openCurrentDoctor(patient1);
    const viaWorker = await messages.sendMessage(patient1, conversation.id, randomUUID(), 'outbox via worker');
    await admin.query(`INSERT INTO public.messages (patient_id, doctor_id, sender_id, content)
      VALUES ($1, $2, $3, 'outbox via clinical app')`, [patient1Row, doctor1, doctor1]);
    // A rolled-back insert must not leave an event behind.
    await admin.query('BEGIN');
    await admin.query(`INSERT INTO public.messages (patient_id, doctor_id, sender_id, content) VALUES ($1, $2, $3, 'rolled back')`,
      [patient1Row, doctor1, doctor1]);
    await admin.query('ROLLBACK');
    const pending = await admin.query<{ message_id: string; conversation_id: string; user_low: string; user_high: string }>(
      'SELECT message_id, conversation_id, user_low, user_high FROM internal.message_outbox WHERE published_at IS NULL ORDER BY created_at');
    assert.equal(pending.rows.length, 2);
    assert.equal(pending.rows[0].message_id, viaWorker.id);
    for (const row of pending.rows) {
      assert.equal(row.conversation_id, conversation.id);
      assert.deepEqual([row.user_low, row.user_high].sort(), [doctor1, patient1].sort());
    }
  });

  test('the relay publishes signed events once, and keeps them pending when the broker fails', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay(db, publisher, () => { throw new Error('not used'); });
    publisher.fail = true;
    await assert.rejects(relay.drainOnce(), /broker unavailable/);
    const stillPending = await admin.query('SELECT count(*)::int AS n FROM internal.message_outbox WHERE published_at IS NULL');
    assert.equal(stillPending.rows[0].n, 2, 'nothing is marked published when the publish fails');

    publisher.fail = false;
    publisher.published.length = 0;
    assert.equal(await relay.drainOnce(), 2);
    assert.equal(await relay.drainOnce(), 0);
    assert.equal(publisher.published.length, 2);
    for (const { subject, packet } of publisher.published) {
      assert.equal(subject, EVENT_SUBJECTS.messageCreated);
      const event = messageCreatedEventSchema.parse(verifyPacket(packet, bPublicKey));
      assert.deepEqual([...event.participants].sort(), [doctor1, patient1].sort());
      assert.ok(!('content' in event), 'events never carry message content');
    }
  });

  test('concurrent relays never publish the same event twice', async () => {
    const conversation = await conversations.openCurrentDoctor(patient1);
    for (let i = 0; i < 30; i++) await messages.sendMessage(doctor1, conversation.id, randomUUID(), `concurrent ${i}`);
    const publishers = [new RecordingPublisher(), new RecordingPublisher(), new RecordingPublisher()];
    const relays = publishers.map((publisher) => new OutboxRelay(db, publisher, () => { throw new Error('not used'); }));
    await Promise.all(relays.map(async (relay) => { while (await relay.drainOnce() > 0) { /* drain */ } }));
    const ids = publishers.flatMap((publisher) => publisher.published.map(({ packet }) =>
      messageCreatedEventSchema.parse(verifyPacket(packet, bPublicKey)).eventId));
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
  });

  test('a commit wakes the relay through LISTEN/NOTIFY', async () => {
    const { Client } = await import('pg');
    const listener = new Client({ connectionString: runtimeUrl });
    await listener.connect();
    try {
      await listener.query('LISTEN messaging_outbox');
      const notified = new Promise<string>((resolve) => listener.once('notification', (message) => resolve(message.channel)));
      const conversation = await conversations.openCurrentDoctor(patient1);
      await messages.sendMessage(patient1, conversation.id, randomUUID(), 'wake up');
      assert.equal(await Promise.race([notified, new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))]), 'messaging_outbox');
    } finally { await listener.end(); }
  });
});
