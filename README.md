# Messaging Platform POC

Separate NestJS monorepo for two-user messaging. It contains a public REST API gateway (A), a private NestJS NATS worker (B), fixed internal GraphQL operations executed in B, and Supabase Auth/Postgres migrations.

```text
Client --HTTPS REST--> A --NATS request/reply--> B --restricted PostgreSQL role--> Postgres
```

Only A exposes an application HTTP listener. B does not expose a GraphQL HTTP endpoint; it executes a fixed GraphQL schema and documents through its NATS handlers. Both services verify the user JWT. A signs requests and B signs replies with separate Ed25519 keys. B binds the verified user ID to a transaction-scoped PostgreSQL setting; RLS uses that setting. The migration targets the **existing ClinicalWebApp Supabase project**. Its Data API and Realtime stay enabled for the clinical app, with its existing authenticated-user RLS policies preserved.

## Current POC capabilities

- Create or reuse a conversation between a patient and their currently assigned doctor.
- List the caller's conversations.
- Send a message with database-backed `clientMessageId` idempotency.
- Read message history with stable cursor pagination and a single database statement when the fast-history migration is installed.
- Reject invalid user JWTs, forged service packets, wrong NATS subjects, replayed request IDs, and nonmember database access.

## NestJS Observe

Both NestJS services are instrumented. A uses `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET`; B uses the B-prefixed variables in the ignored root `.env`. Compose passes each pair only to the corresponding process. Observe API keys are **project scoped**, so both pairs may hold the same valid project key while the services keep distinct `serviceId` values (`api-gateway` and `messaging-service`). This local setup uses the same verified project key for both after an older gateway key was rejected. If you rotate it, update both pairs and restart both processes; credentials are read at startup.

The SDK traces HTTP and NATS requests and database timing, and forwards Nest logs with trace correlation. HTTP request-body capture and error source snippets are disabled. Run `podman compose --env-file .env logs api-gateway messaging-service` and look for `Observe is connected` from both services. Never commit the keys.

## Reading Podman logs

```powershell
podman compose --env-file .env logs -f api-gateway messaging-service nats
```

Each application log line includes `service`, `stage`, and a `requestId`. The gateway returns the same ID in the `X-Request-ID` HTTP response header and places it in the signed NATS request. Search that ID across both services to follow a call through `http.start`, `auth.accept`, `nats.publish`, `nats.verified`, `graphql.start`, `db.start`, `db.done`, `handler.done`, `nats.reply`, and `http.done`. Failure lines include a status or a short error code and elapsed milliseconds. The logs omit message bodies, user JWTs, database credentials, and patient or doctor identifiers.

The browser sends the email/password login directly to Supabase Auth, so that login does not appear in Podman logs. The gateway's first authenticated request after login does. NATS broker logs show connection and broker events; the gateway and worker logs show individual messaging operations.

### History query performance

Apply `supabase/migrations/20261127_fast_message_history.sql` in the existing Supabase project's SQL Editor as the migration owner, then restart `messaging-service`. Its startup log should say `stage=db.history_fast_path enabled=true`. A history read then sends one database statement that sets a transaction-local actor, verifies current conversation membership through RLS, and fetches one indexed message page. The replay claim remains a separate database round trip. The old multi-statement read is retained as a fallback until the migration is installed. Compare `operation=listMessages stage=db.done durationMs=...` before and after; the REST and NATS APIs do not change. The migration creates a function only and does not rewrite the message table or add a duplicate index.

Live push, an outbox/JetStream relay, cross-network deployment manifests, and production observability are subsequent phases. The local broker now uses operator/account/user JWTs and NKeys, and supports TLS (see *NATS TLS* below); the default local Compose network is still plaintext, so **do not deploy it across networks without enabling TLS**. With `NODE_ENV=production` both services refuse to start unless `NATS_TLS_CA_FILE` is set.

### Current security status

The local broker now uses **NATS decentralized authentication**: an operator signs the messaging account, the account signs separate gateway and worker user JWTs, and each client proves possession of its NKey seed when connecting. The generated local broker uses a memory account resolver with the account JWT preloaded. It has no password user list. Its credentials and issuer seeds are generated under ignored `secrets/nats/`; Compose mounts only each service's own `.creds` file. A can publish the exact messaging subjects plus an authentication probe and subscribe only under `_INBOX.gateway.>`; B can subscribe to those subjects and send one response per request. This is a local bootstrap, not a production credential lifecycle: the user JWTs currently have no expiry, and the memory resolver is not the recommended full resolver for dynamic account updates.

At the application layer, B checks A's Ed25519 packet signature, signed audience, the 15-second request window, the NATS subject/operation match, the Supabase user JWT, and the actor ID match. It atomically claims the request ID in PostgreSQL; duplicate or failed claims reject the request. A verifies B's signed reply, audience, request ID and hash, and freshness. The signed packet is a custom format, not standard JWS, and has no key IDs or rotation. The replay check adds one database round trip per operation; `clientMessageId` handles legitimate REST retries after timeouts.

A stolen patient JWT and gateway NATS credentials still cannot forge a new request without A's separate packet-signing key. A stolen gateway creds file can receive that gateway identity's replies; a stolen worker creds file can receive forwarded requests. The gateway's reply subscription is now limited to its own inbox prefix, but the current local NATS connection remains **plaintext**. Signatures do not encrypt message content or user JWTs. Use TLS with server verification and private connectivity before crossing networks. Broker credentials, service signing keys, and the restricted database password must be stored and rotated separately.

B refuses to run unless its database login is the non-superuser `messaging_b_runtime` role without RLS bypass. It sets the verified actor ID only within a transaction; RLS then checks current doctor–patient membership. A stolen DB credential is still serious because that role can set the actor ID. When a patient changes doctors, the previous doctor loses access to that pair's conversation, while the database retains the history.

## Prerequisites and setup

1. Install Node.js 24+, npm, and Docker Desktop (or another Docker engine). Use the existing ClinicalWebApp Supabase project with asymmetric Auth JWT signing keys, a patient profile/row, and their assigned doctor. Keep its Data API and Realtime enabled.
2. Apply the ClinicalWebApp migrations first, including its message RLS policy. Then apply `supabase/migrations/20261124_clinical_messaging.sql` once as the migration owner, followed by `supabase/migrations/20261124_messaging_portals.sql`, `supabase/migrations/20261127_fast_message_history.sql`, and `supabase/migrations/20261128_error_codes.sql`. The first extends `public.messages`, backfills existing messages into conversations, and adds a trigger so the clinical app's old insert shape keeps working. The second adds replay-table RLS policies and limited access to current care-contact names. The third speeds up history reads without changing tables. The fourth gives SQL business-rule errors stable SQLSTATE codes (`MP400`/`MP403`/`MP404`) so B returns 400/403/404 instead of 503; B also understands the pre-migration messages, so the order of deploying B and this migration does not matter. **Before applying the first two migrations**, check whether `public.patients` and `public.profiles` already have RLS enabled (`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('patients','profiles')`): enabling RLS on a table that the clinical app reads without policies would block those reads. Do **not** apply the removed standalone messaging migration. The first migration creates a new restricted `messaging_b_runtime` role and leaves any pre-existing `messaging_app` role untouched. Set a strong password for `messaging_b_runtime` **outside source control**, restrict database network access to B's egress, use a session-pooler connection string for that role, and download the database CA certificate. Back up the database and plan a maintenance window if `public.messages` is large: backfill and constraints take locks.
3. Run `npm install`, `npm run build`, and `npm run nats:bootstrap` in this repository. The bootstrap runs once and refuses to overwrite existing identities. Keep `secrets/nats/operator.seed`, `account.seed`, and `system.seed` in a trusted offline store for production; only `gateway.creds` and `worker.creds` are mounted to their respective services. Never commit or share any `.creds` or `.seed` file.
4. Copy `.env.example` to `.env`. Set `SUPABASE_URL` to the clinical project's URL, `SUPABASE_PUBLISHABLE_KEY` to its browser-safe publishable key, and `DATABASE_URL` to the **restricted `messaging_b_runtime` role**, never `postgres`. Put the database CA certificate at `secrets/db-ca.pem`. Run `npm run keys:generate` and paste the four application signing-key values into `.env`. For host-based runs, set `NATS_A_CREDENTIALS_FILE` and `NATS_B_CREDENTIALS_FILE` to the generated files. Compose mounts those files at fixed container paths. The Supabase JWT, NATS credentials, and A/B packet-signing keys are distinct identities.
5. Start Docker Desktop or Podman, then run `docker compose --env-file .env up --build` or `podman compose --env-file .env up --build`. The web interface is at `http://127.0.0.1:3001/` and A's REST API is at `http://127.0.0.1:3001/v1`; B has no public HTTP endpoint. NATS port 4222 is mapped only to host loopback for local debugging. After bootstrap, a connection without a valid user JWT and matching NKey seed is rejected. Run `npm run nats:verify` on the host to check A/B request-reply and rejection of anonymous and old password connections.

If an earlier SQL Editor run failed inside `BEGIN`, run `ROLLBACK;` in that session before retrying the updated migration. After it succeeds, verify the new runtime role with `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'messaging_b_runtime';`; both privilege flags must be `false`. Set its password separately and update only B's `DATABASE_URL`.

For host-based development, start the NATS service with `docker compose up nats`, then run `npm run start:b` and `npm run start:a` in separate terminals after building.

Obtain user access tokens with Supabase Auth for the two test accounts. All messaging calls go to A with `Authorization: Bearer <access-token>`.

## Configuration reference (added settings)

| Variable | Service | Default | Purpose |
| --- | --- | --- | --- |
| `TRUST_PROXY` | gateway | `false` | Express `trust proxy`: hop count (`1`), `true`, or proxy addresses. Set it to your load balancer so per-IP limits see real client addresses. |
| `THROTTLE_SESSION_PER_MINUTE` | gateway | `120` | Requests per minute per signed-in session (bearer token). |
| `THROTTLE_IP_PER_MINUTE` | gateway | `1200` | Flood limit per client IP; sized so a clinic behind one NAT address is not throttled. |
| `NATS_TLS_CA_FILE` | both | unset | CA used to verify the NATS broker. Required when `NODE_ENV=production` or `NATS_REQUIRE_TLS=true`. |
| `NATS_TLS_CERT_FILE` / `NATS_TLS_KEY_FILE` | both | unset | Optional client certificate for mutual TLS. |
| `DATABASE_SSL_MODE` | worker | `verify-full` | `disable` is allowed only outside production (local Postgres, integration tests). |
| `DATABASE_POOL_MAX` | worker | `10` | Database pool size per worker replica. |

The gateway exposes `GET /v1/health` (unauthenticated, not rate limited). It returns 503 while the NATS connection is down; Compose uses it as the container health check.

### NATS TLS

1. Create a CA and a broker certificate whose subject alternative names match the host in `NATS_URL` (for Compose: `DNS:nats`).
2. Run the bootstrap with the broker-side paths: `NATS_SERVER_TLS_CERT=/etc/nats/tls/server-cert.pem NATS_SERVER_TLS_KEY=/etc/nats/tls/server-key.pem npm run nats:bootstrap`, and mount the certificate directory into the `nats` container at `/etc/nats/tls`.
3. Use `tls://` in `NATS_URL` and set `NATS_TLS_CA_FILE` for both services (and for `npm run nats:verify`).

## Tests

- `npm test` runs the unit tests of every workspace.
- `npm run test:integration` also runs the database integration tests. They apply the real migrations to a disposable PostgreSQL server and check RLS, triggers, idempotency, pagination, reassignment, replay claims and index use. They need a **disposable** superuser URL because they create and drop their own database and the `messaging_b_runtime` role:

  ```sh
  docker run --rm -d -p 54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
  TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres npm run test:integration
  ```

CI (`.github/workflows/ci.yml`) runs `npm audit`, the build, unit and integration tests, and a Docker image build on every push and pull request.

## Simple web interface

`apps/web` is a static patient/clinician messaging UI served by A, so browser calls to the messaging REST API stay on the same origin. Sign in with a Supabase email/password account. Patients can choose **Message my doctor** without entering a doctor ID: B reads the currently assigned doctor from `public.patients`, then creates or reuses that pair's conversation. Doctors can choose one of their currently assigned patients by name and create or reuse that conversation. Both can send and read messages. The page polls every five seconds while visible; it does not provide live push or read receipts. The browser stores the short-lived Supabase session in tab-scoped `sessionStorage` and refreshes it when needed. The publishable key returned by `/v1/public-config` is designed for browser use; never put a secret or service-role key there.

Care-contact names come from `public.profiles` through B's restricted role and RLS. A conversation whose peer is no longer an assigned contact remains hidden by the conversation RLS policy. This is a POC interface and requires both migrations, the restricted DB connection, valid Supabase Auth settings, and the four service signing keys before messaging will work.

## Postman patient/doctor demo

Import `postman/messaging-demo.postman_collection.json` and `postman/messaging-local.postman_environment.json`, then follow `postman/README.md` to demonstrate patient send, doctor read/reply, and gateway-to-worker log correlation.

## REST examples

```text
POST /v1/conversations
{ "otherUserId": "<recipient-user-uuid>" }

POST /v1/conversations/current-doctor
No body; patient access token required.

GET /v1/conversations

GET /v1/conversations/care-contacts

POST /v1/conversations/<conversation-uuid>/messages
{ "clientMessageId": "<new-uuid>", "content": "Hello" }

GET /v1/conversations/<conversation-uuid>/messages?limit=50
GET /v1/conversations/<conversation-uuid>/messages?limit=50&before=<nextCursor>
```

Retry a timed-out send with the **same** `clientMessageId`. A returns the committed message only after B replies. Each REST request has a six-second NATS deadline.

## Adding another service

Run `npm run service:new -- <service-name>` to create the same NestJS service layout with a deny-all guard. Follow `SERVICE_CONVENTIONS.md` to add versioned contracts, a distinct NATS identity and subject grants, signed request/reply checks, persistence, Compose wiring, and tests. The root build and test scripts discover workspaces in dependency order; the Dockerfile also picks up new workspaces. Run `npm install` after scaffolding to update the lockfile.

## Repository structure

- `apps/api-gateway/src/transport/http`: REST controllers and request logging; `security`: Supabase JWT guard; `transport/nats`: signed NATS client.
- `apps/web`: static sign-in and messaging interface served by A.
- `apps/messaging-service/src/security` and `transport/nats`: signed-request guard and NATS handlers; `application`: fixed GraphQL operations; `persistence`: restricted PostgreSQL session and focused query repositories.
- `packages/contracts`: NATS subjects, strict request/response schemas, cursors.
- `packages/security`: Ed25519 packet signatures and Supabase JWT verifier.
- `supabase/migrations`: adaptation of the clinical `public.messages` table, dedicated DB role, RLS, replay table, and database functions.
- `scripts/bootstrap-nats.mjs`: generates the local operator/account/user JWT trust chain, credentials, and broker configuration under ignored `secrets/nats/`.

## Production security work

Use private connectivity or a VPN to the NATS hub and NATS TLS with server verification. Move the issuer seeds to a managed offline store; use a full account resolver, scoped signing keys, expiring user credentials, revocation, and a tested rotation process. Give each A instance its own NATS user identity and reply inbox prefix. An attacker holding one instance's credentials can still read that instance's replies. Run B without public ingress. Preserve and audit the clinical Data API/RLS policies and restrict database ingress to B. B must verify the JWT **before** it sets `app.user_id` in a database transaction; the database role itself can set that value, so protecting its credential is essential. Set `TRUST_PROXY` only for the actual load balancer; per-IP limits are a flood guard, and the primary limit is per session. Add signing-key IDs and rotation, event outbox/JetStream, audit trails, and production observability before handling sensitive data.

See `ARCHITECTURE.md` for the full deployment topology, trust model, and phased plan.

See `CODE_WALKTHROUGH.md` for a source-file and line-reference explanation of the implementation.
