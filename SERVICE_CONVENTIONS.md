# Service structure and extension guide

The gateway and the worker have different responsibilities, but both follow the same NestJS service skeleton. Keep entry points and module registration at the root of `src`; put transport, security, application behavior, persistence, and domain errors in separate segments.

```text
apps/<service>/
  package.json
  tsconfig.json
  src/
    main.ts             process bootstrap and listener
    app.module.ts       dependency injection and handlers
    transport/          HTTP or NATS adapters; no database queries
    security/           bearer or signed-packet guards
    application/        use cases and GraphQL schema/documents if needed
    persistence/        database connection and focused query modules
    domain/             domain-specific errors and types
```

Current gateway map:

- `transport/http`: REST input validation, routes, public config, request ID and completion logging.
- `security`: user bearer JWT verification.
- `transport/nats`: signed request/reply client; reply correlation and timeout mapping.

Current messaging worker map:

- `transport/nats`: versioned subject handlers and signed replies.
- `security`: A signature, audience, freshness, subject, Supabase JWT, actor, and replay validation.
- `application`: fixed GraphQL schema, documents, and executor. It has no HTTP GraphQL endpoint.
- `persistence/database-session.ts`: restricted pool, role check, transaction-scoped actor ID, and DB lifecycle. `persistence/replay.store.ts`: replay claims. `persistence/database-errors.ts`: SQLSTATE mapping.
- `persistence/conversation.repository.ts`, `care-contact.repository.ts`, and `message.repository.ts`: focused SQL operations. The GraphQL executor depends on these repositories directly.
- `domain`: operation error codes.

## Add a service

1. Run `npm run service:new -- <name>`. It creates the same folders, a NestJS NATS bootstrap, and a global **deny-all guard**. It has no message handlers. Do not remove that guard until the replacement validation has tests.
2. Define a versioned subject, strict request/reply contract, audience, and operation mapping in `packages/contracts`. Add a separate NATS account/user identity and the narrowest publish/subscribe permissions. Do not reuse the gateway or messaging worker `.creds` file.
3. Implement the service's request guard: verify the trusted service signature; check audience, issuance/expiry, subject-to-operation binding, user JWT and actor; atomically claim the request ID for replay protection. Sign replies with a service-specific key and verify them at the caller. Keep keys and NATS credentials distinct.
4. Put NATS/HTTP adapters in `transport`, business work in `application`, and SQL in `persistence`. Run database operations as a restricted, non-superuser role and enforce the appropriate RLS policy. Keep request IDs in structured logs without logging JWTs or message bodies.
5. Add a Compose service with its own credentials and no public port unless it intentionally serves a public API. Give it only the network access it needs. For cross-network deployment, use private connectivity and NATS TLS with server verification.
6. Run `npm install` to update the workspace lockfile, then `npm run build` and `npm test`. The scripts discover workspaces and build internal dependencies first. The Dockerfile accepts new workspaces without editing copy instructions. Add tests for signature, replay, authorization, and a real request/reply path before deployment.

The scaffold is a starting point, not an authenticated service. A new service becomes reachable only after its own credentials, contracts, verification, deployment wiring, and tests are complete.
