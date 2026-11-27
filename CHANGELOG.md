# Changelog

## 2026-11-27 (b): Live delivery replaces polling

### What changed
- **Push instead of poll.** The browser keeps one server-sent-events stream (`GET /v1/events`) and fetches only new messages when notified.
  - Idle tabs make no requests (measured: 0 requests in 30 s, previously 6).
  - Delivery took 15–80 ms in end-to-end tests.
- **Transactional outbox.** Migration `20261129_message_events.sql` adds `internal.message_outbox` and an `AFTER INSERT` trigger on `public.messages`.
  - Messages written directly by the clinical app produce events too.
  - Rolled-back inserts produce none.
- **Relay in the worker.** It is woken by `LISTEN/NOTIFY` and claims rows with `FOR UPDATE SKIP LOCKED`, so it is safe with many replicas. It signs each event with the worker's key and marks rows published only after the broker has accepted them.
  - A 10 s safety check covers missed notifications; it is a single index probe when idle.
- **Gateway event hub.** It verifies each event's signature, schema and freshness, de-duplicates by `eventId`, and routes events only to the two participants.
  - Stream limits are configurable per user and per instance.
  - Heartbeats keep proxies from closing idle streams.
  - A stream ends when the access token expires.
  - `/v1/health` reports the event subscription status and the number of open streams.
- **Events carry IDs only**, never message content; the content is read through the normal authorised history endpoint.
- **`after` cursor** on message history (`latestCursor` in every page), plus a single-statement SQL function for it.
- **Web client.**
  - Reads the stream with `fetch`, so the token goes in a header, not the URL.
  - Reconnects with exponential backoff and jitter.
  - Fills gaps after reconnecting and detects dead streams.
  - Marks conversations with new messages as unread.
  - Falls back to a 15 s poll only while disconnected.

### Fixed along the way
- **Gateway no longer crashes on old NATS credentials.** If the gateway's NATS identity lacks event permission, REST keeps working and `/v1/events` returns 503, so browsers poll every 15 s. `/v1/health` reports `"events":"forbidden"` and the log names the fix. The streams also close on a broker disconnect, so clients reconnect and fill any gap.
- **`nats:update-permissions` safeguards.** It refuses to run against an outdated `packages/contracts/dist`, and rewrites the `.creds` files in place so Docker bind mounts pick them up.
- **Cursor precision.** Cursors and timestamps were truncated to milliseconds, while PostgreSQL stores microseconds. Paging back through several messages written within the same millisecond could skip some of them. Timestamps now keep microseconds (`...30.022123Z`).
- **NATS permissions were wider than intended.** The worker identity had no publish restriction (an empty allow list means "everything"), so it could publish request subjects. It may now publish only `messaging.v1.event.>`; replies still work through its response permission.

### Upgrade
1. Apply `supabase/migrations/20261129_message_events.sql`.
2. Run `npm run build && npm run nats:update-permissions` (keeps existing keys), then recreate both services (`docker compose up -d --force-recreate api-gateway messaging-service`). `npm run nats:verify` confirms event delivery.
3. Ensure `DATABASE_URL` uses a session-mode connection (Supabase session pooler, port 5432) so `LISTEN` works.
4. Behind a load balancer, set its idle timeout above `EVENT_HEARTBEAT_MS` (25 s).

### Tests
- **Unit tests: 26 → 38.** New coverage:
  - Event routing, de-duplication and connection limits.
  - Signature and freshness checks.
  - SSE framing and token-expiry close.
  - Relay wake-up batching.
  - Timestamp precision.
  - Contract rules.
- **Integration tests: 10 → 16.** New coverage:
  - Microsecond paging.
  - `after` cursor.
  - Exactly-one outbox row, including clinical-app inserts and rollbacks.
  - Publish failure leaving rows pending.
  - Three concurrent relays never publishing the same event twice.
  - `NOTIFY` on commit.
- **End to end:** real NATS over TLS and two browsers.
  - Unread marker, delivery latency, and clinical-app insert delivery.
  - Zero idle requests.
  - Gateway restart with gap fill.
  - A doctor outside the conversation receiving nothing.

## 2026-11-27: Architecture review fixes

### Robustness
- **Worker crash on dropped DB connections fixed.** The pg pool now has an `error` listener, so an idle connection closed by the server or pooler no longer terminates the process.
- **Broken connections are no longer reused.** If `ROLLBACK` fails, the connection is destroyed (`release(err)`) and the original error is preserved.
- **Correct HTTP statuses.**
  - SQL business-rule failures now carry SQLSTATE codes (`MP400`/`MP403`/`MP404`, migration `20261128_error_codes.sql`).
  - RLS violations (`42501`) map to 403 instead of 503.
  - A user token rejected by the worker now returns 401, so the web client refreshes the session. Before, it returned 502.
  - Service faults and replays still return 502.
- **Rate limiting works behind proxies and shared NAT.** The primary limit is now per session (a hash of the bearer token, never unverified claims). A higher per-IP limit acts as a flood guard. `TRUST_PROXY` configures Express's proxy trust. The previous single limit of 60 requests/min per IP would have throttled entire clinics.
- **Startup fails fast** on missing or malformed signing keys, NATS credentials or TLS settings, with a single clear log line. Previously this was only discovered on the first request.
- **Health check.** The gateway serves `GET /v1/health`. The gateway connects to NATS eagerly at startup.
- **Faster, correctly scoped conversation list.** It now filters on the participant columns, so the per-participant indexes are used. Before, every conversation was scanned and filtered by RLS.
- **Deterministic queries.** `LIMIT 1` patient lookups now have an `ORDER BY`.
- **Replay-nonce cleanup.** Expired nonces are kept for 5 minutes, comfortably past the accepted clock skew. Cleanup failures are logged.
- **Web client.** "Load older messages" is no longer ignored while a background poll is in flight.

### Security
- **NATS TLS support:**
  - `NATS_TLS_CA_FILE`, plus optional client certificates for mutual TLS.
  - `NODE_ENV=production` refuses to start without TLS.
  - The bootstrap script can emit the broker's `tls {}` block.
  - `nats:verify` supports TLS.
- **The user JWT no longer reaches persistence.** It is verified in the guard; repositories receive only the verified actor ID.
- **Specific rejection reasons are logged** (`expired`, `subject_mismatch`, `invalid_user_token`, ...) without any user data.
- **Database TLS stays mandatory.** `DATABASE_SSL_MODE=disable` exists for local testing only and is refused in production.
- **Docker image:**
  - Multi-stage build.
  - Runs as the non-root `node` user with `NODE_ENV=production`.
  - Ships production dependencies only; no sources or tests.
- **Compose:** healthchecks, start ordering on broker health, restart policy, and a clearly named network.
- **Observe** is disabled in the gateway when no keys are set, matching the worker.

### Code quality and dead code
- **Removed the `MessagingRepository` pass-through facade.** Replay claims moved to a dedicated `ReplayStore`.
- **Removed the unused `token` parameters** threaded through four layers.
- **De-duplicated helpers into `@messaging/security`:** the 6 copies of `required()` became `requiredEnv`, and NATS connection options are now shared by both services and the service scaffold.
- **Signing keys** are parsed once and cached, and must be Ed25519.
- **GraphQL documents** are parsed and validated once at startup instead of on every request.
- **NATS permissions are generated from `@messaging/contracts`**, so they can no longer drift from the handlers.
- **Dependencies tidied:**
  - Removed the duplicate root dependency on `@nestjs/observe`.
  - The NATS client is now declared by the package that uses it.
- **Stricter compiler settings:** `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` and `noFallthroughCasesInSwitch`.

### Tests and CI
- **Unit tests:** 11 → 26. New coverage:
  - Guard rejection codes.
  - Transport error mapping.
  - Session throttling and `TRUST_PROXY` parsing.
  - Transaction and broken-connection handling.
  - SQLSTATE mapping.
  - Key and TLS validation.
- **10 PostgreSQL integration tests** (`npm run test:integration`). They run every migration against a real server and check:
  - Backfill.
  - RLS isolation.
  - Trigger enforcement when the repository check is bypassed.
  - Idempotent sends and conflicting ID reuse.
  - Cursor pagination.
  - Doctor reassignment.
  - Concurrent replay claims.
  - Index use.
- **GitHub Actions CI:** audit, build, unit and integration tests (Postgres service), and a Docker build.

### Upgrade notes
1. Apply `supabase/migrations/20261128_error_codes.sql`. It is optional for compatibility: the worker also understands the old messages.
2. Run `npm install`, then `npm run build`.
3. Behind a reverse proxy, set `TRUST_PROXY`.
4. For any deployment beyond one machine, enable NATS TLS (see README).
