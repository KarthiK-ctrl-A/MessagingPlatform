# Messaging Platform source map

This map describes the current refactored source. The files under `dist/`, `node_modules/`, and `package-lock.json` are generated or third-party material.

## Request flow

1. `apps/api-gateway/src/main.ts` starts A's HTTP listener, security headers, static web app, and request-ID middleware. `app.module.ts` registers controllers, JWT verification, rate limiting, and the NATS client.
2. `apps/api-gateway/src/transport/http/conversations.controller.ts` validates REST input and chooses a messaging operation. `security/auth.guard.ts` verifies the Supabase access token. `transport/http/request-logging.ts` assigns the response's `X-Request-ID`.
3. `apps/api-gateway/src/transport/nats/nats-gateway.service.ts` signs the operation packet and sends it to a subject from `packages/contracts`. It validates B's signed reply, correlation hash, freshness, and timeout.
4. `apps/messaging-service/src/security/request.guard.ts` verifies A's signature, audience, time window, subject/operation match, user JWT, actor ID, and replay ID. `transport/nats/nats.controller.ts` handles the verified request and signs its response.
5. `apps/messaging-service/src/application/graphql-executor.service.ts` runs a fixed GraphQL document from `graphql-documents.ts` against `graphql-schema.ts`. Documents are parsed and validated once at startup, and resolvers call the conversation, care-contact and message repositories directly with the verified actor ID; no GraphQL HTTP listener is exposed.
6. `apps/messaging-service/src/persistence/database-session.ts` owns the restricted PostgreSQL pool (with an idle-error handler), checks its role, and sets the actor ID for one transaction; a connection whose ROLLBACK fails is destroyed instead of being reused. `database-errors.ts` maps SQLSTATEs (`MP400`/`MP403`/`MP404`, `42501`, `P0002`, ...) to typed domain errors. `replay.store.ts` claims request IDs and cleans up expired ones. `conversation.repository.ts`, `care-contact.repository.ts`, and `message.repository.ts` contain their respective SQL. `row-mappers.ts` maps database rows to response fields. PostgreSQL RLS checks current doctor/patient membership.

## Live event flow

7. A committed insert into `public.messages` fires the trigger in `supabase/migrations/20261129_message_events.sql`. It writes `internal.message_outbox` and sends a NOTIFY. `apps/messaging-service/src/events/outbox-relay.service.ts` publishes a signed event for each pending row. `apps/api-gateway/src/transport/events/event-hub.service.ts` verifies it, and `event-router.ts` forwards it to the participants' streams opened through `transport/http/events.controller.ts`. The browser then calls the history endpoint with `after=`.

## File responsibilities

| Path | Purpose |
| --- | --- |
| `apps/api-gateway/src/transport/http/public-config.controller.ts` | Exposes only the Supabase URL and browser-safe publishable key for sign-in. |
| `apps/api-gateway/src/transport/http/conversations.controller.ts` | REST routes and Zod input validation. |
| `apps/api-gateway/src/transport/http/request-logging.ts` | Generates a server-side request ID and logs HTTP start/finish. |
| `apps/api-gateway/src/security/auth.guard.ts` | Requires and verifies a user's bearer token. |
| `apps/api-gateway/src/transport/nats/nats-gateway.service.ts` | Signs NATS commands, waits for one reply, verifies B's signature and request correlation. |
| `apps/messaging-service/src/security/request.guard.ts` | Rejects forged, stale, misrouted, invalid-user, and replayed packets. |
| `apps/messaging-service/src/transport/nats/nats.controller.ts` | Binds NATS subjects to GraphQL operations and signs replies. |
| `apps/messaging-service/src/application/graphql-schema.ts` | Internal GraphQL type and operation definitions. |
| `apps/messaging-service/src/application/graphql-documents.ts` | Fixed, server-owned GraphQL queries and mutations. |
| `apps/messaging-service/src/application/graphql-executor.service.ts` | Executes a fixed document and maps its result or domain error. |
| `apps/messaging-service/src/persistence/database-session.ts` | Pool, role check, transaction-scoped actor identity, broken-connection handling, lifecycle. |
| `apps/messaging-service/src/persistence/database-errors.ts` | SQLSTATE to domain-error mapping. |
| `apps/messaging-service/src/persistence/replay.store.ts` | One-time request-ID claims shared by all worker replicas. |
| `apps/messaging-service/src/persistence/timestamps.ts` | Keeps PostgreSQL microseconds in timestamps and cursors. |
| `apps/messaging-service/src/events/outbox-relay.service.ts` | LISTEN-driven relay: claims outbox rows, publishes signed events, marks them published. |
| `apps/messaging-service/src/events/event-publisher.ts` | NATS connection used only to publish live events. |
| `apps/api-gateway/src/transport/events/event-hub.service.ts` | Subscribes to live events and verifies signature, schema and freshness. |
| `apps/api-gateway/src/transport/events/event-router.ts` | Routes events to participants' streams; de-duplication and connection limits. |
| `apps/api-gateway/src/transport/http/events.controller.ts` | `GET /v1/events` server-sent-events stream with heartbeats and token-expiry close. |
| `apps/messaging-service/src/persistence/conversation.repository.ts` | Open, create, and list conversations. |
| `apps/messaging-service/src/persistence/care-contact.repository.ts` | Find current doctor or patient contacts by role. |
| `apps/messaging-service/src/persistence/message.repository.ts` | Idempotent send and cursor-based history. |
| `apps/messaging-service/src/persistence/row-mappers.ts` | Maps PostgreSQL column names and dates to API fields. |
| `apps/messaging-service/src/domain/domain-error.ts` | Domain error code and message type. |
| `packages/contracts/src/index.ts` | Allowed NATS subjects, strict packet schemas, cursor codec. |
| `packages/security/src/index.ts` | Ed25519 packet signing/verification and Supabase JWT verification. |
| `scripts/bootstrap-nats.mjs` | Generates local NATS operator, account, user JWTs/NKeys, permissions, and credentials. |
| `scripts/workspaces.mjs` | Discovers workspaces and runs build/test in dependency order. |
| `scripts/new-service.mjs` | Creates a same-layout service with a deny-all default guard. |
| `apps/web/` | Static patient/doctor interface served by A. |
| `supabase/migrations/` | Existing clinical-schema adaptation, runtime role, RLS, and replay table. |
| `postman/` | Importable patient-to-doctor request/reply demonstration. |

See `SERVICE_CONVENTIONS.md` for the extension rules and `ARCHITECTURE.md` for deployment and trust boundaries.
