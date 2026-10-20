# Conventions

CNC's canonical rules record. These decisions are settled. They are written
down so every later card inherits them rather than re-deciding them, and every
rule carries its reason on the same bullet: if one looks arbitrary, read the
reason before changing it.

**"The plan"** below is `docs/cnc-phase-plan.md` in the TAYxCNC workspace docs
repository (beside this repository, not inside it). `A1`…`A22` are its
architecture decisions (§3), `Q1`…`Q37` its questions for the founder (§18).
Many rules here were first learnt in TAY's backend (`tayxcnc-backend`), which
is this repository's pattern source: its files are copied and adapted, never
imported (A3).

Sections marked *(from C3)* or later describe code that does not exist yet.
They are here so the first card that builds it starts from the rule.

---

## Isolation from TAY

- **CNC and TAY share no data layer, no auth realm and no environment.** This
  service has its own database (`cnc_db`, user `cnc_app`), its own JWT secret,
  its own Paystack merchant account, its own bucket and its own service
  accounts. The two businesses share a venue and a domain, and either must be
  able to change, move or fail without touching the other.
- **Nothing from `tayxcnc-backend` is referenced at build or run time** (A3).
  A TAY file is copied in, renamed and owned here. An import across
  repositories would make a TAY change a CNC change that nobody reviewed here.
- **CNC never reads a `TAY_*` variable, and the service refuses to boot when
  one is present** (A4). See *Configuration*.

## Contract conventions

- **Every route is prefixed `/api/v1/`, from the first endpoint** (A5).
  Versioning added later means moving every path, in every client, at once.
- **REST, plural nouns, kebab-case paths**: `/staff/stock-items`, never
  `/staff/getStockItems`. The verb is the HTTP method. One shape means a
  reader can guess a route and a reviewer can spot one that is wrong.
- **A staff command is one route over one ported command function**, for
  example `POST /api/v1/staff/orders/:id/settle` (A6). It runs in one
  interactive transaction that locks the rows it changes and writes its audit
  row through the same transaction, so a command either happens with its
  record or does not happen at all.
- **camelCase JSON. Timestamps are ISO 8601 in UTC.** One casing and one
  instant format, so no client keeps a per-field parser.
- **Money is always an integer field named `*Kobo`** (A5). Never Float, never
  Decimal: floating point on currency produces rounding errors that surface as
  reconciliation failures months later. ₦2,500 is `250000`.
- **Money is stored and transported in kobo and formatted only at the display
  layer.** A stored `250000` rendered directly shows a price a hundred times
  too high.
- **Money sums in SQL are taken as `bigint`** (plan §10). An `Int` `_sum` of a
  year's sales overflows.
- **A business date is `YYYY-MM-DD` (`@db.Date`), never a timestamp** (A5).
  It names a day, not an instant: serialised as `2026-10-20T00:00:00.000Z` it
  renders as the previous day for any client west of Greenwich. The same rule
  binds requests: validate such a field with a `YYYY-MM-DD` pattern, never
  `@IsDateString`, which accepts `2026-10-20T23:30:00-05:00`, a value that is
  the 21st in Jos and has no correct resolution.
- **Business dates and times are computed in `Africa/Lagos` from the server
  clock, through `src/common/wat.ts` only** (A11). Browser clocks are
  untrusted, so the demo clock, `clock.tick` and every client-built `+01:00`
  timestamp go away: a client sends a date and a time and the server builds
  the instant. Nigeria is UTC+1 all year, so the offset is the whole rule, but
  it lives in one place: two copies would disagree only between midnight and
  one in the morning, the hardest hour to notice.
- **Enums travel as `UPPER_SNAKE`; each frontend maps them to its labels in
  one adapter** (A5). The screens already show labels such as "Part Paid" and
  keep them unchanged; a label is display copy, with spaces and capitals that
  are not a stable identifier. One adapter per frontend keeps every label in
  one file, so a wording change never needs an API change.
- **Every list endpoint returns `{ data, page, pageSize, total }`** (A5).
  Identical shape, no exceptions, so one client-side pagination helper serves
  all of them.
- **An optional request field that must not be `null` is guarded with
  `@ValidateIf(isSent)`, not `@IsOptional()`.** `@IsOptional` skips every
  validator for `null` as well as for an absent field, so `"note": null` would
  reach the service as a value nothing had checked. `isSent` is false only for
  `undefined`.
- **Staff are identified by id, never by name** (A10). Every actor is the
  staff id from the token, and names are joined for display. The demo keys
  own-record checks, approval totals, task assignment and the audit actor by
  display name, and names are not unique.
- **Primary keys are `cuid`; human numbers come from sequences** (A12). See
  *Data and migrations*.

## Errors

- **Every error body is `ApiErrorResponse`.** One shape, so each frontend has
  one place that reads a refusal.
- **A refusal's `message` is kept byte for byte from `staff/lib/domain.ts`
  in `cnc-frontend`** (A7), for example "Only the Owner can change a price."
  The screens show the message verbatim (`staff/components/cnc/ui.tsx`, and
  the comments in `lib/account/api.ts`), so a reworded message is a visible
  change on a screen nobody touched. When porting a command, copy the string
  from the domain; never retype it.
- **Status codes** (A7):
  - `400`: the input is wrong.
  - `403`: refused by role, by an Owner-only rule, by an approval limit, or by
    the own-record rule.
  - `404`: the record does not exist.
  - `409`: a state conflict, or a stale `version` (see *Optimistic
    concurrency*).

  Each frontend's data layer turns any non-2xx into its existing
  `{ ok: false, error }`, so the screens stay unchanged. The code is chosen so
  a client can tell "fix your input" from "you may not" from "someone else
  changed it" without parsing the sentence.
- **A unique-index clash is a `409`, never a `500`.** Read the violated
  columns with `uniqueViolationTargets` (see *Data and migrations*, `P2002`).
- **The exceptions filter never records request headers.** Headers carry the
  `Authorization` token and cookies, including TAY's (see *Auth*).

## Optimistic concurrency

- **Every row two devices can edit carries a `version` integer** (A8): orders,
  online orders, reservations, table sessions, stock items, requests,
  purchases, waste, kitchen entries, tasks, vendors, assets, maintenance
  records, attendance records, menu items, settings, business and staff. The
  acceptance case is two cashiers settling the same bill (BE §2, §12).
- **A write names the `version` it read. A stale one is refused with `409`
  and exactly "This record changed. Refresh and try again."** The second
  writer would otherwise overwrite a change they never saw. The sentence is
  fixed so both frontends can show it as it stands.
- **The check and the increment happen in one statement, or under the row
  lock taken by the command's transaction.** A read-then-compare in two
  statements lets two writers both pass the check, which is the race the
  version exists to stop.

## Idempotency

- **An `Idempotency-Key` header (a UUID) is required on order create, part
  payment, settle, online balance, web checkout and reservation create** (A9).
  These are the writes that take money or a table. A phone on a poor network
  that retries after a lost response would otherwise order, charge or book
  twice.
- **The first response is stored with the key; a repeat with the same key
  returns that stored response.** Keys live in `IdempotencyKey`, unique on
  (`scope`, `key`), where `scope` is `staff:<id>`, `customer:<id>` or
  `anon:<ip-hash>`, and are swept after 7 days (plan §4.8). Scoping stops one
  caller's key from replaying another caller's response.
- **`Idempotency-Key` is in the CORS `allowedHeaders`, and an e2e spec
  preflights every route that takes it.** A custom header makes the browser
  send a preflight first; a header missing from the allowlist fails that
  preflight, the call never reaches the API, and every test that calls the API
  directly still passes. TAY shipped this class of defect once, with `PUT`.

## Configuration

- **Every setting CNC reads is `CNC_`-prefixed, except `PORT` and
  `NODE_ENV`** (A4). That includes the values TAY reads unprefixed:
  `CNC_CORS_ORIGINS`, `CNC_RESEND_API_KEY`, `CNC_MAIL_FROM`, `CNC_VAPID_*` and
  the seed variables. CNC staging lives in the same GCP project as TAY
  (`tayxcnc-staging`), and production will share one project with TAY too.
  TAY's unprefixed names (`CORS_ORIGINS`, `MAIL_FROM`, `RESEND_API_KEY`…) are
  TAY's own secrets: if CNC mounted them, a TAY change would silently change
  CNC. With a prefix on every name, CNC cannot mount or read a TAY secret by
  accident. `PORT` and `NODE_ENV` are set by the platform and the toolchain,
  not by either business.
- **In the running service, only `CncConfigService`
  (`src/config/cnc.config.ts`) reads the environment**, through its `own*()`
  readers, plus `PORT` and `NODE_ENV`. `bootstrap.ts` receives its CORS list
  from the service, and `main.ts` reads nothing. One door means one place to
  audit what the service can see. Outside the service, the Prisma CLI config
  and the seed scripts read `CNC_DB_URL` (and a seed's own `CNC_SEED_*`
  flags) by their literal names, because they run without the Nest
  container.
- **The service refuses to boot when any `TAY_*` variable is present** (A4).
  A TAY value in this container means a deploy mounted the wrong secret; a
  loud failure at deploy beats a service quietly configured by the other
  business. The refusal names the variables, never their values.
- **`npm run check:env-names` fails on any `process.env` read in `src/`,
  `prisma/` or `scripts/` whose name is not `CNC_*`, `PORT` or `NODE_ENV`,
  and on any read whose name it cannot see** (an alias such as
  `env = process.env`, or a computed key) outside the config. CI runs it from
  the first PR (plan §11). The boot refusal catches a TAY value in the
  environment; this catches the code side, a read of a name the prefix rule
  forbids, before it merges. A read it cannot name is a read it cannot check,
  so it fails rather than warns.
- **`CNC_ENV` says which deployment this is; `NODE_ENV` does not.**
  `NODE_ENV` is `production` on staging too, because it is a build flag.
  `CNC_ENV` is `local`, `staging` or `production`, and every per-deployment
  rule keys on it. **A built container (`NODE_ENV=production`) refuses
  `CNC_ENV=local`**, because `local` skips the deployed rules below; running
  the image on a laptop means `CNC_ENV=staging` with staging's variables.
- **Everywhere, local included:** `CNC_JWT_SECRET` is at least 32 characters
  after trimming and is not a placeholder (`CHANGE_ME`,
  `PLACEHOLDER_NOT_SET`). A signing secret copied from `.env.example` is
  public, and a short one is brute-forceable; both sign and verify perfectly
  in every test.
- **Deployed boot rules** (staging and production, plan §11):
  `CNC_SWEEP_TOKEN` set, at least 32 characters and not a placeholder (it is
  a bearer credential); `CNC_CORS_ORIGINS` non-empty, with every entry a bare
  origin (`scheme://host[:port]`, no path, no trailing slash), because the
  match is exact and anything else, such as `CNC_WEB_URL`'s `…/cnc` pasted in
  by mistake, can never match a browser.
- **Production adds:** an `https://` `CNC_WEB_URL` ending in `/cnc` with no
  trailing slash (every link and Paystack callback is built from it); an
  `https://` `CNC_STAFF_URL` with no trailing slash (links in staff emails);
  `https://` CORS origins (credentials are on); a contact email (enquiries
  and payment problems go there); a live Paystack key (`sk_live_`, so
  production cannot take test-mode money); and a socket or `sslmode=require`
  database URL. Each is a mistake that deploys cleanly and fails later.
- **Refusals report every problem in one error and never print a value**,
  not even an invalid `CNC_ENV`, because a secret mounted under the wrong name
  would otherwise land in the boot log. One failed deploy shows every problem,
  and a boot log is not a place for secrets.
- **`CNC_WEB_URL` carries the base path** (`https://tayxcnc.com/cnc`, plan
  §13). Paths passed to `buildWebUrl` never start with `/cnc`, and production
  refuses a value ending in `/`. TAY's web URL is a bare origin; a literal copy
  of TAY's pattern would build `/cnc/cnc/…`. A unit test pins
  `buildWebUrl('/account')` to `https://tayxcnc.com/cnc/account`.
- **`.env.example` lists every variable the service reads, with a safe
  placeholder and a comment.** It is the one file a new machine copies from,
  so a variable missing from it is a boot failure nobody can explain.

## Data and migrations

- **Prisma is pinned exactly, to `7.10.0`** (A1), with `@prisma/client` and
  `@prisma/adapter-pg` at the same version, `pg` at `8.23.0` and
  `pg-connection-string` at `2.14.0`. These are the versions TAY runs in
  production-shape today. A caret range would let a fresh `npm ci` pick up a
  release nobody tested; Prisma 8 is a rewrite that emits a schema contract
  instead of a client, and is excluded until it is evaluated on its own card.
- **The generator stays `prisma-client-js`, with output
  `generated/cnc-client`** (A1). Prisma deprecates it in favour of
  `prisma-client`, which emits TypeScript and so moves the build output and
  the Docker image layout. That move is its own card; the deprecated
  generator compiles and runs cleanly under 7.10.0. Import the client from
  `generated/cnc-client`, never from `@prisma/client`, which is not the client
  generated from this schema.
- **`generated/` is gitignored, so run `npx prisma generate` after a clone or
  a schema change.** Without it `nest build` fails on missing modules rather
  than on anything real. `generate` needs no database.
- **`prisma.config.ts` reads `process.env.CNC_DB_URL`, never Prisma's
  `env()`** (plan §11). `env()` throws as soon as the config loads if the
  variable is unset, and the config loads for `prisma generate` too, which
  runs in CI's lint and build jobs and in the Docker build, none of which has
  a database. The Prisma CLI no longer loads `.env` on its own, so the config
  loads it with `dotenv/config`.
- **The client needs a driver adapter, and the URL reaches it through the
  config service.** Prisma 7 has no bundled engine. `CncPrismaService` builds
  a `PrismaPg` from `CncConfigService.databaseUrl`, with connect and idle
  timeouts of 5 s and 300 s (node-pg's defaults, none and 10 s, hang requests
  during an outage and churn connections through the Cloud SQL proxy).
- **The pool has an explicit `max` of 3** (plan §11, §19). CNC staging shares
  a db-f1-micro instance (about 25 connections) with TAY, which alone can open
  about 40. CNC's 3 × 2 instances is the most it may add.
- **`prisma migrate dev` is local only.** It compares the database with the
  migration history and offers to reset on drift; against staging or
  production that is data loss. `npm run db:migrate` is `migrate dev`.
- **Staging and production are migrated with `migrate deploy`, run by hand
  through the Cloud SQL proxy, before the merge that needs the migration, on
  the founder's go-ahead** (plan §12.3, §15). Never from CI, never from the
  deploy workflow, never from the container: a deploy that migrates on its
  way past gives no one the chance to read the plan, and Cloud Run starts
  several instances at once, so an automatic migration races itself. Before
  the merge, because the merge deploys code that expects the new schema.
- **Drop a column only after the deploy whose code stops reading it is
  live**, in a later migration. Prisma selects every column its schema names,
  so a running image that still names a dropped column fails on every read of
  that table.
- **Two connection-string forms, deliberately different.** Locally and
  through the proxy, a TCP URL (`localhost:5432` for local Postgres,
  `localhost:5433` for the proxy); in Secret Manager, the Unix socket form
  (`…@localhost/cnc_db?host=/cloudsql/…`) with no port. Neither works in the
  other's place.
- **A timestamp written by raw SQL is taken `now() AT TIME ZONE 'UTC'`.** The
  columns are `timestamp` without a zone and Prisma writes UTC into them; a
  bare `now()` is cast in the session's zone. On a local database set to
  Africa/Lagos, TAY's first raw-SQL row was stamped an hour ahead of every row
  the service wrote. Staging is UTC and would have hidden it.
- **A `P2002` carries its columns in two shapes.** Without the adapter it is
  `meta.target: ["email"]`; Prisma 7 with the adapter gives
  `meta.driverAdapterError.cause.constraint.index: "Staff_email_key"`.
  `uniqueViolationTargets` reads both. A refactor that reads only one turns
  every deliberate `409` into a `500`, which is what happened to TAY during
  its upgrade until the e2e suite caught it.
- **Human numbers come from Postgres sequences through `nextSequenceCode`,
  never from `max + 1`** (A12). Reading the highest value and adding one is
  two statements with a gap between them: two orders in that gap get the same
  number, one loses the unique index, and a customer is told the server broke.
  `nextval` is atomic. One sequence per prefix (`CNCR`, `CNCB`, `WEB`, `PAY`,
  `CASH`, `RSV`, `SR`, `PR`, `W`, `T`, `MT`, `CNC-S`, `CNC-`, plan §4.8); the
  demo's single shared counter also burned a number on every audit row. Two
  properties follow: **numbering has gaps** (a sequence burns its value when a
  transaction rolls back), and **the digit count is a floor, not a width**, so
  nothing may order by the code string. Anything that imports rows must
  re-seed the sequence afterwards with its migration's `setval`.
- **Read every model and field name from `prisma/schema.prisma` before using
  it.** Never assume one from a document: TAY once had seven name mismatches
  between a blueprint and its schema, and every task built on them had to be
  rewritten.
- **Stored text is plain text, and there is no sanitiser.** Nothing strips
  markup on the way in or out, so anything rendered from the database must be
  escaped by the renderer.
- **A script that writes to a database refuses anything but a local one
  unless its own `CNC_SEED_*_ALLOW_REMOTE=true` is set** (`remoteDatabaseRefusal`
  in `prisma/local-database.ts`). See *Local environment*.
- **The first Owner is seeded from `CNC_SEED_OWNER_EMAIL` /
  `CNC_SEED_OWNER_PASSWORD`, kept off Prisma's `seed` key** (plan §12.1,
  from C3). `migrate reset` runs the `seed` key, and a reset must never
  create a credential.

## Auth *(from C3)*

- **Staff sign in with a work email and an argon2id password** (A14), via
  `@node-rs/argon2`, not the native `argon2` package, which needs a native
  toolchain to build. The access token lasts 15 minutes and is held in memory.
- **Refresh tokens are opaque, SHA-256 hashed, single-use and rotated.** The
  raw token is 32 random bytes; 256 bits has nothing to brute-force, and
  argon2's per-record salt would force a table scan on every refresh. SHA-256
  is deterministic, so the digest is the lookup key.
- **Customers sign in with a 6-digit one-time code** (A15): hashed, 10
  minutes, resend after 30 s, 5 tries, issuance capped per contact and per IP.
  **Checkout never creates a session**; a guest's details link to an account
  only after a verified code. The demo's code-less checkout sign-in is a
  security hole.
- **Cookies** (A16): `cnc_refresh_token` (customers) and
  `cnc_staff_refresh_token` (staff), **host-only** on the CNC API host,
  `Secure`, `Path=/api/v1/auth`, **always `SameSite=Lax`**. There is no
  `CNC_COOKIE_DOMAIN`. Two names, because one browser can hold both sessions.
  The narrow path means ordinary API calls carry no refresh credential.
  Lax works because every CNC frontend, staging included, is served from a
  `tayxcnc.com` host, same-site with `api-cnc*.tayxcnc.com`; this deliberately
  differs from TAY's attribute builder, which returns `None` for a host-only
  cookie in production. A Vercel preview address (`*.vercel.app`) cannot hold
  a session.
- **Set and clear a cookie only through the helpers in `refresh-cookie.ts`**,
  never with attributes spelled out at a call site. A browser ignores a clear
  whose attributes differ from the set, and the symptom, a user who cannot
  sign out, appears long after the change that caused it.
- **There is no cookie parser; read cookies with `readCookie`, by their exact
  `cnc_*` name.** `req.cookies` is always undefined.
- **TAY's cookies reach this API, and CNC never reads, logs or returns them**
  (A16). TAY sets its refresh cookies with `Domain=.tayxcnc.com`, so browsers
  send them to `api-cnc*.tayxcnc.com` too. No logger, exception filter or
  audit row records the `Cookie` header, and an e2e test sends a
  `tay_refresh_token` and asserts it appears in no log and no response.
  Narrowing TAY's cookie is a TAY change (Q23 d).
- **A refresh that authenticates by cookie requires `Content-Type:
  application/json`.** Lax still sends the cookie on same-site requests, and
  every `tayxcnc.com` host is same-site, so a page on another host could make
  the browser POST a refresh and sign the user out by spending the token. The
  three CORS-safelisted content types need no preflight; requiring JSON
  forces one, and it fails for an origin off the allowlist. Check the header,
  never whether a body parsed.
- **Both guards re-read `isActive` and the role from the row on every
  request** (A14), and every token is revoked on a role, email or status
  change. Deactivation that waits for a 15-minute token to expire is
  advisory. A deactivated account is `403` with a message naming the state; a
  subject whose row is gone is `401`.
- **A token of the other realm on a route is `403`, not `401`;** a
  foreign-signed or invalid token is `401`. A `401` sends a valid client into
  a pointless re-login loop.
- **The last-Owner rule is the domain's** (plan §11): `403`, "CNC needs at
  least one active Owner." An Owner may step down while another active Owner
  exists. TAY's self-lockout rule is not copied.

## CORS

- **The allowlist is exact and comes only from `CNC_CORS_ORIGINS`**, read by
  `CncConfigService.corsOrigins` and passed into `bootstrap()` (plan §11).
  Comma separated, full origins, no paths. **There is no origin pattern, in
  code or in the environment, on any deployment.** TAY's entry point admits a
  Vercel preview pattern locally; CNC does not, because anyone can register a
  Vercel project whose name matches a pattern, and a preview cannot hold a
  session against a deployed API anyway (A16). A developer pointing a preview
  at a local API lists that exact origin in their local `CNC_CORS_ORIGINS`.
- **A refused origin is logged only when it is short and printable**; anything
  else is logged as "(malformed or oversized)". The Origin header is chosen by
  the caller, and an unbounded value in the log is the caller writing into it.
- **Rejection is `callback(null, false)`, never a thrown `Error`.** Throwing
  answers `500`, so every drive-by origin scan becomes a server error and the
  5xx rate stops being a usable signal. Returning false omits
  `Access-Control-Allow-Origin` and the browser refuses the response, which
  is where enforcement belongs.
- **Rejections log at `verbose`.** Unknown origins on a public URL are routine
  traffic, not an incident. If the logger is ever restricted to
  `['log','warn','error']` these lines vanish, and CORS will look inactive in
  Cloud Logging.
- **`credentials` is on, and that is safe only because the allowlist is
  explicit.** The refresh cookie is not attached to a cross-origin request
  without it. **Never reflect the request's own `Origin` back while
  credentials are on**: that trusts every origin on the internet and hands any
  page the authenticated response it asked for.
- **Every method a route uses is in `CORS_METHODS`.** A missing method fails
  the browser's preflight while every direct test passes; TAY's first `PUT`
  route failed on staging and on no test. An e2e spec reads every documented
  route and fails on a method not listed.
- **Every custom request header is in `allowedHeaders`**: today
  `Content-Type`, `Authorization` and `Idempotency-Key` (A9). The reason is
  the same as for methods, and a preflight spec covers every route that takes
  `Idempotency-Key`.
- **An empty or missing `CNC_CORS_ORIGINS` blocks every browser while health
  checks and `curl` pass.** That is why a deployed service refuses to boot
  without it (*Configuration*), and why the deploy workflow must mount it.
- **Which production origins are trusted depends on Q1.** At
  `tayxcnc.com/cnc` the CNC site shares one browser origin with TAY's public
  site, so trusting `https://tayxcnc.com` also trusts code on TAY's pages.

## Infrastructure

- **Region `europe-west1`, locked** (A1). Cloud SQL cannot move, and CNC
  staging uses TAY's existing instance there.
- **CNC has its own runtime and deployer service accounts, scoped to CNC**
  (plan §12.3). On staging: `tayxcnc-cnc-runtime@` with `cloudsql.client`,
  `secretAccessor` on each CNC secret only, `storage.objectAdmin` on the CNC
  bucket only, `serviceAccountTokenCreator` on itself and `logging.logWriter`;
  `tayxcnc-cnc-deployer@` with **no project-level role**: `run.admin` on the
  service `tayxcnc-cnc-staging`, `artifactregistry.writer` on the repository
  `tayxcnc-cnc`, `serviceAccountUser` on the CNC runtime. TAY's accounts are
  never reused: they hold project-wide grants, and an unscoped CNC deployer
  could delete TAY's service or overwrite TAY's images.
- **The runtime's `cloudsql.client` is a project-level grant with a
  condition** limiting it to `tayxcnc-staging-pg`. Cloud SQL has no
  per-instance IAM policy, so the project is the only place it can be
  granted; the condition keeps it to the one instance CNC uses.
- **The project's IAM policy carries a condition, so every
  `gcloud projects add-iam-policy-binding` on it needs `--condition=None` or
  an explicit condition.** Without one, gcloud asks which to apply, and a
  non-interactive shell fails at that prompt.
- **Workload Identity Federation only.** No service-account JSON keys (org
  policy forbids creating them) and never `credentials_json` in a workflow.
  CNC gets one new `workloadIdentityUser` binding on its deployer, on the
  existing pool and provider, **for the subject
  `repo:tayxcnc@312678855/cnc-backend@1415513595:ref:refs/heads/develop`
  only**, not the whole repository. Only a push to `develop` deploys staging,
  so a workflow on any other branch, including one a pull request adds,
  cannot impersonate the deployer. The deploy job must therefore never gain
  an `environment:` key: that changes the token's subject to
  `…:environment:<name>` and the binding stops matching.
- **This repository issues GitHub's immutable OIDC subject**, with the owner
  and repository ids after `@` (`gh api
  repos/tayxcnc/cnc-backend/actions/oidc/customization/sub` shows
  `use_immutable_subject: true`). A binding written in the older
  `repo:tayxcnc/cnc-backend:…` form never matches. The first staging deploy
  failed that way, with `iam.serviceAccounts.getAccessToken` denied. The ids
  also mean a renamed or recreated repository cannot inherit the binding.
- **Database users created with `gcloud sql users create` are members of
  `cloudsqlsuperuser`, with `CREATEDB` and `CREATEROLE`.** `cnc_db` is
  therefore created through the Admin API and handed to `cnc_app` with
  `ALTER DATABASE … OWNER TO`, so no other user inherits its ownership, and
  PUBLIC's `CONNECT` on it is revoked. `CREATE DATABASE` over the proxy was
  dropped by the instance mid-statement on the shared `db-f1-micro`, which is
  why the Admin API is used. Databases left owned by `cloudsqlsuperuser`
  (`tay_db`, `postgres`) are owner-reachable by every such user, `cnc_app`
  included: a TAY-side gap, reported as Q23.
- **Every Cloud Run deploy passes `--service-account`.** Omitted, Cloud Run
  falls back to the default compute account, which holds far more authority
  than a web API should and cannot read CNC's secrets, so the deploy succeeds
  and the revision fails to start.
- **`--set-secrets` and `--set-env-vars` each replace their whole collection
  on every deploy.** A value added by hand with `gcloud run services update`
  is gone at the next push to `develop`. Add values in the deploy workflow,
  never by hand, and list every secret there.
- **A placeholder secret is literally `PLACEHOLDER_NOT_SET`.** Never format
  one to resemble the real thing: a placeholder Resend key beginning `re_`
  passed every check, deployed cleanly and failed silently at the first send.
  On staging only `CNC_PAYSTACK_SECRET_KEY` (until C7), `CNC_RESEND_API_KEY`
  and `CNC_MAIL_FROM` (until C6) may hold it; every other secret is real from
  the start.
- **Secrets are created with `printf`, never `echo`** (see *Local
  environment*).
- **The Artifact Registry repository `tayxcnc-cnc` must exist before the
  first deploy.** Enabling the API does not create it.
- **Nothing in the media bucket is public; the stored value is the
  `gs://bucket/object` URI, and a fresh V4 signed URL is minted per read**
  (A17). A stored signed URL expires and becomes a link that worked once.
  Signing needs `serviceAccountTokenCreator` on the runtime account, granted
  to itself: without it uploads succeed and every download fails.
- **Cloud Scheduler jobs send `Content-Length=0` and are created with
  `--format="value(name)"`** (plan §11), so the job works against Cloud Run
  and the sweep token is never printed.
- **Each `cnc-staging-sweep-*` job is created in the card that adds its
  route, not before.** A job pointed at a route that does not exist yet
  fails on every run, and a scheduler log full of expected 404s hides the
  failure that matters.
- **Production provisioning runs from Google Cloud Shell, not a development
  machine.** Production credentials never sit on a machine where an agent has
  a shell.

### Never touched from CNC work

These are TAY's, on the shared staging project (plan §12.3). CNC work does
not change, read the values of, or redeploy any of them, because a CNC card
must never be able to take TAY staging down:

- the service `tayxcnc-tay-staging`;
- the database `tay_db` and the user `tay_app`;
- instance settings on `tayxcnc-staging-pg`;
- TAY's secrets: `TAY_DB_URL`, `TAY_JWT_SECRET`, `TAY_PAYSTACK_SECRET_KEY`,
  `TAY_REDIS_URL`, `TAY_WEB_URL`, `TAY_CONTACT_EMAIL`, `TAY_SWEEP_TOKEN`,
  `TAY_COOKIE_DOMAIN`, and the unprefixed `CORS_ORIGINS`, `MAIL_FROM`,
  `RESEND_API_KEY`, `TERMII_API_KEY` and `VAPID_*`;
- the accounts `tayxcnc-tay-runtime` and `tayxcnc-deployer`;
- the Scheduler jobs `tay-staging-sweep-pitch-holds`,
  `tay-staging-sweep-notifications`, `tay-staging-sweep-memberships`,
  `tay-staging-sweep-tokens` and `tay-staging-sweep-sign-ups`;
- the buckets `tayxcnc-tay-staging` and `tayxcnc-tay-staging-media`;
- the Artifact Registry repository `tayxcnc`;
- the `api-staging` domain mapping;
- the WIF pool and provider.

Gaps found on TAY's side (project-wide grants, the shared cookie domain,
TAY's unbounded pool) are reported to the founder as Q23, never fixed from
here.

## Making changes to source files

- **Edit files with the editor tools only. No `sed`, `awk`, `perl` or any
  other in-place shell rewrite, and no shell redirection to write a source
  file.** Both have silently damaged files in TAY's repository: `awk`
  stripping the line endings from a schema, and a stray `perl -i -pe` leaving
  a service syntactically invalid.
- **Check `git diff --numstat` after any automated edit.** A whole-file
  line-ending change inside a small diff is invisible in review and surfaces
  later as a merge conflict.
- **Never edit `package-lock.json` by hand.** It is written by `npm install`,
  and a hand edit is a lockfile that no install produced.

## Git and workflow

- **`develop` is the integration branch; `main` is always deployable.** Work
  branches come off `develop` and their PRs go into `develop` (plan §20).
  `develop` should be the default branch on GitHub (Q24), so a PR opened
  without thought targets the right branch.
- **Feature PRs are squash-merged into `develop`; a release is `develop` →
  `main` with a merge commit, never squash** (workspace Team SOP; plan §20).
  A squashed release leaves `main` with history `develop` does not share, so
  the next release starts from no common point: the entrance's squashed
  release had to have its trees reconciled by hand
  (`release-2026-10-20.md`).
- **The agent opens backend PRs and never merges.** Only the founder merges.
  The agent never pushes to `develop` or `main`, tags, force-pushes or
  deletes a branch. Review by the founder is the only gate there is: branch
  protection is unavailable on private repositories under GitHub Free.
- **Self-review the diff against the published contract** (the Swagger
  document) before opening a PR: every field name, type and status code. That
  review and CI are what catch contract drift here.
- **No AI attribution anywhere.** No `Co-authored-by` trailer, no tool
  reference in a commit message or PR description, no `.claude/`, `.agents/`
  or `.windsurf/` directory committed. This is the founder's standing rule,
  and the repository may reach the client at handover.
- **PR descriptions are brief and plain**: what changed, why, how it was
  verified. The founder reviews every PR and is the only gate, so a
  description has to be read quickly and trusted; padding hides the one line
  that matters.
- **Commit identity is this repository's local config, `Israellongji
  <israellluka@gmail.com>`** (Q4), set once in this clone and never as a
  global setting. `user.useConfigOnly` is on globally, so a repository with
  no identity refuses to commit rather than guessing one. Never change the
  identity of any other repository: `cnc-frontend` and the entrance commit as
  `tayxcnc`, which their deployments require.
- **Hooks live in `.githooks/` and are enabled with
  `git config core.hooksPath .githooks`, once per clone**: a `gitleaks`
  pre-commit hook and a pre-push hook refusing `main` and `develop`.
  `.git/hooks/` does not travel with a clone, so tracked hooks plus one
  config line is the only way every clone gets them. Both are bypassable with
  `--no-verify`: they are guardrails, not enforcement, and are never bypassed.

## Local environment

- **Node 22**, as `engines` pins (A1). On the founder's machine it comes from
  `nvm`, loaded from `~/.zprofile`, so a non-interactive shell gets the same
  Node as a terminal. Run `node -v` before trusting a local result.
- **Homebrew Postgres 16 on port 5432** (plan §12.1). Homebrew's superuser is
  the Mac user, not `postgres`, so `psql -U postgres` fails.
- **A `cnc_app` role with `LOGIN CREATEDB` owns two databases: `cnc_db` (the
  working copy) and `cnc_test` (for e2e runs).** `CREATEDB` is granted only
  locally, because `migrate dev` creates a shadow database to diff against;
  on staging `cnc_app` has no such right. Two databases, because the e2e
  suite writes rows it never removes, and the seeded working copy should not
  fill with them.
- **The Cloud SQL proxy runs on port 5433, and `localhost:5433` counts as
  remote** (`remoteDatabaseRefusal`). Staging is reached through the proxy on
  a loopback host, so a check on the host alone would wave staging through.
  The check reads the URL with `pg-connection-string`, the driver's own
  parser, so a `?host=` or `?port=` parameter wins as it does for the driver.
  **A local `CNC_DB_URL` names its host and port** (`localhost:5432`): where a
  URL leaves them out, `pg` takes `PGHOST`/`PGPORT`, which CNC does not read,
  so the check treats such a URL as not local. Each writing script has its own
  `CNC_SEED_<X>_ALLOW_REMOTE` flag, read by its literal name and passed in, so
  permitting one remote run never permits another.
- **`printf`, never `echo`, for secrets.** `echo` adds a trailing newline that
  becomes part of the value and fails exactly like a wrong credential. Pipe
  into the command: `printf '%s' "$value" | gcloud secrets create …
  --data-file=-`.
- **Database passwords from `openssl rand -hex 24`.** base64's `+ / =` need
  percent-encoding inside a connection string.
- **`CNC_JWT_SECRET` and `CNC_SWEEP_TOKEN` from `openssl rand -hex 32`.** 64
  hex characters, well over the 32-character floor the service enforces (the
  JWT secret everywhere, the sweep token on deployed services).
- **Never read or print `.env` or any `.env*` file other than
  `.env.example`.** They hold real credentials, and anything printed lands in
  a terminal log or a transcript. Fill `.env` in an editor.
- **Verify from a clean clone, then delete it.** The working tree has
  gitignored files (`.env`, `generated/`, `dist/`, `node_modules/`) that CI
  and a new machine do not, so a check that passes only in the working tree
  proves nothing about either. Delete the clone as soon as its run finishes,
  so a stale copy is never mistaken for the repository.
- **Full local e2e runs use `npm run test:e2e -- --maxWorkers=2`** on the
  founder's 8 GB machine. At Jest's default worker count it swaps, and TAY's
  runs failed on connection timeouts that were not in the code. CI keeps its
  own configuration and is the authority on green. The suite must also pass
  with `--runInBand`.
- **`openapi-cnc.json` is written by the app when it boots outside
  production, and by nothing else.** It is gitignored. To refresh it after a
  contract change, start the app once and stop it when the log says the spec
  was written. Never edit it by hand: `npm run mock` and the frontends read it
  as what the controllers say.

## Verification

- **Nothing is called verified unless it was compiled or run.** State what
  was not run rather than describing untested code as working: a claim nobody
  ran is how a broken guard reaches staging looking green, and the gates are
  planned from what the records say was checked.
- **Verify a guard by watching it fail with the guard removed.** A test that
  passes with and without the guard proves nothing about it.
- **The founder's own checks are recorded in their words** in
  `cnc-progress.md` in the workspace docs repository.
