# Postman patient/doctor messaging demo

This is a sequential nine-request simulation of the current implementation. It uses the same login path as the web portal: patient and doctor sign in directly to Supabase Auth. Every **messaging** request then goes to gateway A's REST API at `{{gatewayUrl}}/v1/...`. Gateway A handles the NATS request/reply exchange with B and returns a single HTTP response to Postman.

## Before running

1. Start the local stack from the repository root:

   ```powershell
   podman compose --env-file .env up --build
   ```

2. Confirm the patient and doctor Supabase Auth accounts exist, the patient is assigned to this **current** doctor, and the project migrations and `messaging_b_runtime` database login are active.
3. Import `messaging-demo.postman_collection.json` and `messaging-local.postman_environment.json` into Postman. Select **Messaging Platform - local demo** as the active environment.
4. Set `patientEmail`, `patientPassword`, `doctorEmail`, and `doctorPassword` in the environment. The sample file contains no credentials. Keep passwords and the access tokens captured during the run private; do not export the populated environment or share the Postman Console output if it contains sensitive details.
5. Keep `gatewayUrl` as `http://127.0.0.1:3001` for local Compose, or change it to A's public URL. The first request discovers the Supabase URL and publishable key from A's `/v1/public-config`. The key must be the browser-safe publishable key, not a service-role key.

## Run the simulation

Run the whole collection **once, in order, with one iteration** using Postman's Collection Runner. The steps are:

| Step | Client HTTP destination | Expected result |
| --- | --- | --- |
| 01 Public config | A | Learns where Supabase Auth is. |
| 02 Patient signs in | Supabase Auth | Saves the patient's access token and user ID locally in the active Postman environment. |
| 03 Doctor signs in | Supabase Auth | Saves the doctor's access token and user ID. |
| 04 Patient opens conversation | A | Finds or creates the conversation with the currently assigned doctor. |
| 05 Patient sends | A | Returns the committed message and its ID. |
| 06 Doctor lists | A | Finds the same conversation. |
| 07 Doctor reads | A | Finds the exact patient message by ID, sender, and content. |
| 08 Doctor replies | A | Returns the doctor's committed reply. |
| 09 Patient reads | A | Finds the exact doctor reply. |

Requests 04–09 send `Authorization: Bearer <access token>` to A. The send requests generate fresh `clientMessageId` values. If a send times out and you retry it manually, keep the **same** `clientMessageId` and content to use the API's idempotency behavior; manually rerunning the request creates a fresh ID.

## Show the internal path without exposing B to the client

1. In Postman, open the **Postman Console**. Each A request logs its HTTP status, client-observed response time in milliseconds, and `X-Request-ID`. The Tests tab checks that the request URL targets A and that A returned the request ID. For step 05, copy the ID from its response header.
2. In another PowerShell terminal, inspect that ID in the application logs:

   ```powershell
   podman compose --env-file .env logs api-gateway messaging-service | Select-String '<paste-X-Request-ID>'
   ```

   Expect to see A's `http.start`, `auth.accept`, `nats.publish`, `nats.reply`, and `http.done`, and B's `nats.verified`, `graphql.start`, `db.start`, `db.done`, and `graphql.done` for that **same** ID. B also logs `nats.received` with the NATS subject before it has verified the packet and extracted its request ID. Some stages may appear in a different order because the services log concurrently. NATS broker logs normally show connections and broker events, not a line for each application message; the A/B application logs show the per-request path.
3. Check the exposure in the local Compose stack:

   ```powershell
   podman compose --env-file .env ps
   ```

   A publishes `127.0.0.1:3001`. B has no published port and starts as a NestJS **NATS microservice**, with no HTTP or GraphQL URL. GraphQL is executed inside B after it receives and verifies the signed NATS packet. The client cannot call B through this Compose setup using an HTTP endpoint.

This demonstrates **interface transparency**: Postman sees one HTTP messaging request to A and one response from A while the same request ID proves that B handled the internal work. It does **not** prove that every request will be fast. Use the response times in Postman as observations for this run; measure p95/p99 under representative load to establish responsiveness. A currently waits up to six seconds for a NATS reply, so a stalled B can still be felt by the user.

This Compose deployment simulates service separation on one local network. It does not prove isolation across zones or networks. NATS is bound to host loopback for local diagnostics and the local broker connection is plaintext. Before deploying across networks, use private connectivity, NATS TLS with server verification, network rules limiting B ingress to the broker path, and the production credential work described in the repository README.

## If a step fails

- Sign-in `400` or `401`: check the account's email/password and Supabase Auth settings.
- Conversation `403`, `404`, or validation error: confirm the patient is assigned to the **doctor account used in step 03** and that B's restricted database role and migrations are active.
- Gateway `503` or `504`: inspect A/B logs and NATS status using the failed request's `X-Request-ID`.
- If the doctor cannot see the patient message, inspect the step 07 Tests result and compare its `patientMessageId` with step 05. Check B's logs for a DB/RLS error.
