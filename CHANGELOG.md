# Changelog

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
