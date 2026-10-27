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
- **A request field answers one sentence at most: validate it with
  `@Checked` (`src/common/checked.ts`) and its `requiredText` and
  `wholeNumber` checks, or a single class-validator decorator, never a stack
  of them carrying one domain sentence** (from C4). Every failing decorator
  adds its own message, so a missing reason under `@IsString`,
  `@IsNotEmpty` and `@MaxLength` answered the domain sentence twice and a
  length sentence beside it, and the staff app joins every message of a 400
  into what the screen shows (`staff/lib/api-client.ts`): the demo's
  sentence would not reach the screen as it stands (A7). An "M+r" reason is
  `@AdminReason` (`src/common/admin-reason.ts`), whose one sentence is the
  demo's "An admin correction requires a reason."
- **An item list in a request (`[{ stockItemId, qty }]`) is validated with
  `@ValidLines` (`src/common/command-lines.ts`), never `@ValidateNested`**
  (from C4). The ValidationPipe prefixes a nested error with its path
  (`lines.0.…`), which changes the sentence a screen shows; `ValidLines`
  answers the demo's `positiveLines` sentences in its order (empty,
  duplicates, quantities), then the command's own sentence for a bad item
  id. The lines stay plain objects, and a service reads only the keys the
  rules name. A command that checks each line's item in its own order
  against another field passes `idMessage: null` and checks the item
  itself (from C5: purchases, whose create asks for the vendor first);
  `positiveLines` never looks at the item, so a DTO refusal of it would
  answer before a sentence the demo gives first.
- **An id field read in a service is read through `sentId`
  (`src/common/sent-id.ts`): a non-blank string, or undefined for anything
  else** (from C5: tasks, repairs and purchase lines). A service that
  judges a field itself, in the demo's order, needs the plain answer to
  "was an id sent"; one copy keeps the three commands agreeing on it, and
  a non-text id becomes the command's sentence instead of a Prisma
  validation 500.
- **A business date in a request or query is checked with
  `@Checked(calendarDate(sentence))` (`src/common/checked.ts`)** (from C4).
  It accepts a real `YYYY-MM-DD` day only (`parseIsoDate`) and answers the
  field's own sentence once ("Enter a valid kitchen date.", "Enter a valid
  reconciliation date."); the docket, kitchen and report queries share it,
  so no two routes disagree on what a date is.
- **The database not answering in time is `503` "CNC is busy right now.
  Wait a moment and try again." with `Retry-After: 2`, never the generic
  500** (`AllExceptionsFilter`, from C8-4): Prisma's P2024 (no pool
  connection in time), P2028 (a transaction that could not start within its
  wait or ran past its timeout, rolled back) and `pg`'s own "timeout
  exceeded when trying to connect" (matched by its exact message). The C8-4
  load test found them as 500s during a stall; nothing was written in any
  of the three, every money and booking write carries an Idempotency-Key,
  so trying again is the right answer and the client is told so. One
  warning line with the code, never Prisma's message (it can name the
  query). Any other database error stays the generic 500.

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
- **Use `claimVersion` (`src/prisma/optimistic-version.ts`) as the first
  statement of the command's transaction, and never increment `version`
  again in the command's own update.** It is the one statement that compares
  and increments, and it leaves the row locked until the transaction ends,
  so the rest of the command runs on a row nobody else can change (the same
  protection as `SELECT … FOR UPDATE`). A second increment would skip a
  version and make the client's next write look stale. Outside a
  transaction the lock is released at once, and the command's write is
  unguarded.
- **A request that writes a versioned row extends `VersionedWriteDto`**
  (`src/common/dto/versioned-write.dto.ts`), so `version` is required,
  validated and documented once. A write that names no version has nothing
  to be stale against and silently overwrites a change it never saw.
- **A model that gains a `version` column is added to `VERSIONED_TABLES` in
  the same change.** `claimVersion` interpolates the table name and refuses
  any name not on the list, and a unit test fails when the list and the
  schema's versioned models differ, so the check cannot be forgotten for a
  new model.
- **A photo upload, a photo removal and a staff ID reissue are versioned
  writes like any other: they claim the row and move its `version`.** A
  person replacing their photo over one a manager uploaded a minute ago, or
  a second manager reissuing an ID the first has just printed, is the lost
  update A8 exists to stop. A multipart upload sends `version` as a form
  field, read through `PhotoUploadRequest` (`src/images/photo-upload.ts`),
  which converts the string before `VersionedWriteDto`'s checks run.
- **The one write to a versioned row that neither checks nor moves
  `version` is a person's own overview layout (`Staff.overviewPrefs`,
  `PUT /staff/me/preferences/overview`).** It is one person's view of their
  own dashboard, not a record two people edit, so the last save wins; and
  moving `Staff.version` would make a manager's edit of the account stale
  because its holder rearranged a dashboard.
- **The opening hours have no `version`: a save replaces the whole week
  under an advisory lock, and the last save wins** (TAY's design, plan
  §4.1). A8 lists no hours, the week is written only by the Owner, and the
  lock already stops two saves interleaving their days.

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
- **A route that takes the key uses `@IdempotencyKey()` for the request,
  `@IdempotentRoute()` for the document, and runs its command through
  `IdempotencyService.execute`** (`src/idempotency/`). The service inserts
  the key row inside the command's own transaction, before the command, and
  stores the response before the commit. So the key and the command commit
  together or not at all, and a duplicate that arrives while the first is
  still running waits on the unique index and then replays, instead of
  running the command a second time. `test/idempotency.e2e-spec.ts`
  preflights every route the API document shows with the header, so
  `@IdempotentRoute()` is what puts a route under that test.
- **Only a successful command stores a response.** A refused or failed
  command rolls back with its key, and a retry under the same key runs
  again. Storing a refusal would replay a "This record changed" 409 for ever
  to a client that has since refreshed and resent the same key.
- **The same key with a different request is `409` "This Idempotency-Key was
  already used for a different request."**, and a missing or malformed key
  is `400` "An Idempotency-Key header holding a UUID is required for this
  request." The request is fingerprinted from its route parameters, query
  and body with keys sorted, so a retry that rebuilt its JSON in another
  order is the same request, and a key reused by mistake never returns the
  answer to some other request.
- **The scope comes from the authenticated subject on the server
  (`idempotencyScope`), never from the request.** A client that could name
  its scope could replay another caller's response by sending their key.
- **Anything a command does outside its transaction is not covered by the
  key**: an email, a Paystack call. It is keyed separately (the
  `OutboundMessage` and `CustomerNotification` `dedupeKey`, Paystack's
  reference) or happens after the commit.
- **Beyond A9's list, a create whose retry would make a second record takes
  the key; a create whose response carries a credential does not.**
  `POST /staff/menu` takes it: a retry after a lost response would add a
  second dish with a `-2` slug. `POST /staff/people` does not: its response
  carries the account's temporary password, which must never be stored, so
  it could not be replayed; a retry is refused on the email instead, and a
  password lost with its response is replaced with the admin reset. An
  update is covered by its `version` and needs no key.

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
- **Web push's key pair and contact, `CNC_VAPID_PUBLIC_KEY`,
  `CNC_VAPID_PRIVATE_KEY` and `CNC_VAPID_SUBJECT`, are set all three or
  none, and checked last at boot** (`readVapid`, `src/config/vapid.ts`;
  `CncConfigService.vapid()`; from C10). Values are trimmed and a blank
  one is unset. The rules key on `CNC_ENV`, never `NODE_ENV`:

  | Situation | Result |
  | :--- | :--- |
  | `local`, none set | `vapid()` is null, with one warning ("CNC_VAPID_* not set: web push is skipped. In-app and email are unaffected."); pushes wait unsent |
  | Some set, any environment | Refuses to boot |
  | `staging` or `production`, none set | Refuses to boot, listed with `assertDeployedConfiguration`'s other problems |
  | A malformed value, any environment | Refuses to boot: the public key must be URL-safe base64 of 65 bytes, the private key of 32 (`PLACEHOLDER_NOT_SET` fails both), neither padded with `=` (web-push's `setVapidDetails` refuses padding, so it would otherwise fail later, inside `PushModule`, in web-push's words), the subject `mailto:` with a domain or a valid `https:` URL, never naming localhost |
  | A private key that does not derive the public key | Refuses to boot: "CNC_VAPID_PRIVATE_KEY does not match CNC_VAPID_PUBLIC_KEY" |

  A subscription is bound to the key it was made with, so a wrong value
  found at the first push costs every device a fresh "Turn On"; refusing
  at boot finds it at the deploy. The derived-key check is CNC's addition
  to TAY's rules: two secrets swapped between environments, or a public
  key beside another pair's private key, pass every length check and then
  fail with 403 at every push service while each device still says "On".
  A deployed service without keys would look healthy and send nothing.
  **Each environment generates its own pair, and never uses TAY's
  unprefixed `VAPID_*`**: a leaked staging key cannot push to production
  devices, and a TAY rotation cannot break CNC's (*Isolation from TAY*).
  No message ever prints a value; the private key is a credential.
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

- **Prisma is pinned exactly, to `7.10.1`** (A1), with `@prisma/client` and
  `@prisma/adapter-pg` at the same version, `pg` at `8.23.0` and
  `pg-connection-string` at `2.14.0`. A1 chose `7.10.0`, the version TAY
  runs; the patch release `7.10.1` replaced it after C8 (2026-10-25, the
  founder's go-ahead for security patches) because `7.10.0`'s own CLI
  package carries `mysql2` and `deepmerge-ts` versions with high
  advisories, which `7.10.1` fixes. A caret range would let a fresh
  `npm ci` pick up a release nobody tested; Prisma 8 is a rewrite that
  emits a schema contract instead of a client, and is excluded until it is
  evaluated on its own card. `package.json`'s `allowScripts` names the
  pinned version, so it moves with the pin.
- **`overrides` holds transitive versions a direct dependency pins below
  its fix: `multer` 2.5.0 (under `@nestjs/platform-express`, which pins
  2.4.0) and `js-yaml` 5.4.3 (under `@nestjs/swagger`, which pins 5.3.0)**,
  both for high or moderate advisories, both the same major line. Remove
  an override once the direct dependency ships the fix itself; `npm audit
  --omit=dev` must stay at 0.
- **The generator stays `prisma-client-js`, with output
  `generated/cnc-client`** (A1). Prisma deprecates it in favour of
  `prisma-client`, which emits TypeScript and so moves the build output and
  the Docker image layout. That move is its own card; the deprecated
  generator compiles and runs cleanly under 7.10.1. Import the client from
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
- **Draw a human number with `drawNumber(prisma, '<kind>')`
  (`src/prisma/sequences.ts`), never by spelling a sequence name or a prefix
  at the call site.** `SEQUENCES` is the one list of sequence, prefix and
  digit count, and a unit test holds it in step with the migrations that
  create the sequences. Two call sites spelling a format would print one
  kind of record two ways.
- **What Prisma cannot express is written by hand at the end of the
  migration, under a "Hand-written below" line, and `prisma migrate diff
  --from-config-datasource --to-schema prisma/schema.prisma --script` must
  still print an empty migration afterwards.** CHECKs, expression indexes,
  triggers and sequences are invisible to the schema; the line tells a
  reviewer which part was generated, and an empty diff proves the
  hand-written part did not drift the schema.
- **The audit log is append-only in the database** (A13): a trigger on
  `AuditLog` raises on UPDATE, DELETE and TRUNCATE. Rows are only ever
  inserted, by `AuditService` inside the command's transaction, and nothing
  (a test, a seed, a sweep) may try to tidy them. A foreign key into it must
  restrict, never cascade or set null: either would be an UPDATE or DELETE
  the trigger refuses. The table's owner can still drop the trigger; that is
  a reviewed migration, not an accident.
- **One-row tables (`Settings`, `Business`) carry a `singleton` column that
  is unique and held true by a CHECK, and are read by `singleton: true`.** A
  second row cannot be inserted by any path, so there is never a question of
  which settings row is the real one.
- **A customer's phone is stored as `0` plus 10 digits, written by
  `canonicalNigerianPhone`** (plan §4.2), and a CHECK on `Customer.phone`
  refuses any other spelling. Requests accept `0…` and `+234…`; storing both
  would let one number be two customers. TAY's copy of the helper returns
  `+234…`; CNC follows its own plan, and the two services never compare
  numbers.
- **Emails that identify a person (`Staff.email`, `Customer.email`) are
  stored lower case, and a CHECK refuses anything else.** The unique index
  is case-sensitive, so `Ada@x.com` and `ada@x.com` would otherwise be two
  accounts.
- **A seed inserts what is missing and never updates a row**
  (`createMany({ skipDuplicates: true })`, keyed on each table's natural
  key: a slug, a room and code, a menu item). Once the Owner has changed a
  price or a manager a description in the staff app, the database is the
  record; a seed that wrote its values again would quietly undo their work,
  and "re-running changes nothing" is then true by construction, with no
  `version` or `updatedAt` moved.
- **Every seed that writes builds its client with `createWritingSeedClient`
  (`prisma/seed-client.ts`), passing its own `CNC_SEED_<X>_ALLOW_REMOTE`
  flag by literal name.** The remote-database check then runs before any
  connection in every seed, and a new seed cannot forget it. Today:
  `CNC_SEED_DATA_ALLOW_REMOTE` (`npm run db:seed`) and
  `CNC_SEED_OWNER_ALLOW_REMOTE` (`npm run db:seed:owner`).
- **The menu is seeded from copies of `cnc-frontend`'s sources in
  `prisma/seed-data/`, joined by `buildMenuSeed` (`prisma/menu-seed.ts`), which
  throws when the website and the staff app disagree on a price, a signature
  or a choice.** The website wins on every field it shows (the shared
  contract's slugs, names and descriptions); the staff file adds the staff id,
  category, department and availability. A seed that silently picked one of
  two prices would be setting a price, which is the founder's decision (Q7),
  not a script's. The copies are not edited to change the menu: after the
  first seed, the menu changes in the staff app.
- **Every Bar menu item has its paired Bar stock item in the same write**,
  and the data seed checks it before committing: a Bar item left unpaired
  (a stock item already holding its name) rolls the whole run back with the
  item's slug. A Bar sale deducts the paired item, so an unpaired Bar item is
  one that can be sold and never counted.
- **The paired Bar stock item's shape lives once, in `BAR_STOCK_SHAPE`
  (`src/menu/bar-stock.ts`), and both writers use it: the data seed and
  `menu.save`.** Two copies of four numbers drift, and a drink the Owner
  adds in the app would then be stocked differently from one seeded beside
  it. `menu.save` creates the pair in the item's own transaction, and a
  stock item already holding the name, ignoring case, refuses the whole
  create with 409 "This stock item already exists."
- **A new menu item's slug is made from its name by `uniqueSlug`
  (`src/menu/menu-slug.ts`), under an advisory lock, and is never reused:
  a second "Zobo Spritz" is `zobo-spritz-2`.** Items are never deleted, so
  every slug ever issued is still in the table; a link or a saved cart that
  names a slug must keep meaning the same dish. The lock stops two creates
  of one name both finding the same slug free.
- **Inside an interactive transaction, read a row's relations with separate
  queries awaited in turn, never a nested `select` or `include`**
  (`readMenuItems` in `src/menu/menu.service.ts` is the pattern). Prisma 7
  sends a nested select's queries on the transaction's one connection at
  the same time; `pg` 8 queues them with a deprecation warning, and `pg` 9
  will refuse them. Outside a transaction the queries go to the pool and a
  nested select is fine.
- **A request field written to an `Int` column is capped at `INT4_MAX`
  (`src/prisma/int4.ts`) in its DTO.** A larger number reaches Postgres as
  an out-of-range error and answers 500; capped, it is a 400 the caller can
  act on.
- **A rule that holds for only some rows of a table (one active booking per
  table and date, one open session per table) is a hand-written partial
  unique index named as Prisma names a unique index,
  `<Model>_<field>[_<field>]_key`** (from C4: `Reservation_tableId_businessDate_key`,
  `TableSession_tableId_key`). The index, not a check in the service,
  decides a race between two writers, and the name lets
  `uniqueViolationTargets` read a clash as its fields, so the service
  answers 409 with the domain's sentence rather than 500. `prisma migrate
  diff` ignores a partial index, so the schema cannot express it and the
  diff still prints an empty migration.

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
- **Every writer of `Staff.passwordHash` hashes through `hashPassword`
  (`src/auth/password.ts`), and every reader verifies through
  `verifyPassword`.** An argon2 digest records its own cost, so a hash made
  with weaker parameters still verifies and nothing reports it. TAY's
  first-admin seed carries its own copy of the parameters for exactly that
  reason to go wrong; here the seed and the auth service share one module.
  `MIN_PASSWORD_LENGTH` (8, TAY's) lives there too.
- **Every writer of `Staff.qrToken` mints it with `generateQrToken`
  (`src/common/qr-token.ts`)**: 32 random bytes, base64url. The token is the
  part of the QR payload that proves possession; one minting function keeps
  its entropy and encoding from drifting between the seed, staff creation
  and the reissue route.
- **The first Owner is seeded only when no Owner account exists, with
  `mustChangePassword` true, and the seed never updates or promotes an
  account.** A re-run that reset the password would revive the one in the
  operator's shell history; one that ran after the Owner changed their email
  would mint a second Owner; promoting an existing account by email would
  turn a typo into an Owner. The seeded password has travelled through a
  `.env` file and a shell, so it is temporary (A14, the C3 gate's first
  step). TAY seeds its first admin with the flag off; CNC's plan does not.
- **Every staff route uses `CncStaffGuard` (`src/auth/guards/`), and a
  handler reads its actor with `@CurrentStaff()`, never from the token or the
  body.** The guard reads the row on every request and leaves the live
  `StaffPrincipal` (id, staff number, name, role) on the request, so a
  command acts as the role the account holds now and an audit row snapshots
  the name it has now. A role in a body is the caller's claim; a role in a
  token is what was true when it was signed.
- **The access token carries `sub` and `type` and nothing else: no role.**
  A14 has the guard read the role from the row on every request, so a role
  claim could only ever be stale, and a claim nobody may trust is one a
  later handler eventually trusts. TAY's token carries roles "for the UI";
  CNC's UI reads them from the session response and `GET /staff/me`.
- **`@Roles(...)` means the demo's `requireRole`: the Owner and Managers
  always pass, and so does every role listed; `@Roles()` with no roles is
  managers only, and no `@Roles` at all is every active staff member.** The
  refusal is 403, "Your current staff role cannot perform this action.",
  byte for byte. Plan §6.2's table is written that way ("managers always pass
  unless the row says otherwise"), so the decorator reads like the table.
  Owner-only rules are not roles: they carry their own "Only the Owner can …"
  sentences and live with the money controls (C3-4) and the staff rules.
  `isManager`, `isOwner` and `roleMayRun` (`src/auth/staff-roles.ts`) are the
  one definition of who a manager is; never restate the list.
- **A deactivated account is refused on every staff route with "This staff
  account has been deactivated. Ask the Owner or a manager if you believe
  this is a mistake." (403), its refresh is the ordinary 401, and its
  sign-in is the identical "Invalid email or password." (401).** The demo
  has no sign-in and so no sentence for this; the C3 gate quotes its
  opening, and the close is in the demo's voice. Sign-in checks the account
  after the password and answers a deactivated account exactly like a wrong
  password, so the route never tells a caller which addresses hold
  accounts; a person already signed in has proved who they are and is told
  the truth. The staff app signs out on both (plan §14).
- **An unknown email at sign-in is verified against a decoy hash before the
  401.** Returning early skips the argon2 work, and the difference in time
  tells a caller which addresses hold accounts even when the body does not.
  TAY's sign-in has that gap; CNC closes it for one argon2 verification per
  miss, on a route limited to ten attempts per address.
- **`@PasswordChangeExempt()` is on three routes only: change-password,
  sign-out and `GET /staff/me` (C3-8).** Change-password is how the flag is
  cleared, and `/staff/me` tells a reloading app who must change it. Sign-out
  is CNC's addition: it only ends sessions, and a person handed a temporary
  password at a shared till must be able to leave. A fourth exemption is a
  question about why the change was forced.
- **A refresh token is spent by one conditional UPDATE (`revokedAt IS
  NULL`, unexpired, of the expected realm), and revocation runs on the
  command's transaction client.** TAY reads the row and then writes it, so
  two refreshes racing with one cookie (a till with two tabs) could both
  succeed and fork the session; the single statement lets exactly one win.
  Revoking inside the transaction makes a new password and the end of the
  old sessions commit together: a new password with the old sessions alive
  is the state that must never exist.
- **Change-password refuses a new password equal to the current one**
  ("Choose a new password that is different from the current one.", 400).
  Otherwise a forced change could be cleared by typing the temporary
  password twice, and the password a manager read out would stay the
  password.
- **The admin reset (`POST /staff/people/:id/reset-password`) sets a
  temporary password from `generateTemporaryPassword`, forces a change at
  first sign-in, ends every session, and returns the password once in the
  response.** TAY emails it; CNC had no mail until C6, so the manager hands
  it over in person. *Settled in C8-5: it stays in person after C6, because
  a staff member who forgot their password is at the venue, and a password
  in an inbox outlives its first use.* It is never stored in
  plain text, logged or written to an audit row. Managers only; a Manager or
  Owner account only by the Owner ("Only the Owner can create or change
  Manager and Owner accounts.", the demo's `staff.save` rule); never one's
  own account ("Use Change Password to change your own password."), because
  change-password asks for the current password precisely so a stolen token
  cannot take an account over. The target row is locked while the rules are
  checked, so a role change landing at the same moment cannot slip past the
  Owner rule. Staff creation (C3-6) issues its first password the same way.
- **Throttling is per route: `@UseGuards(ClientAddressThrottlerGuard)` with
  `@Throttle`, never an APP_GUARD, against a `ThrottlerModule` registered in
  the module that owns the routes, counting in memory** (plan A18: no Redis
  at launch; `src/auth/auth-throttle.ts`). Sign-in, change-password and the
  admin reset allow ten per fifteen minutes per address; refresh thirty,
  because a refused refresh signs a real person out. A global guard would
  put every staff read under the sign-in limit as a side effect. The count
  is per instance, so two instances allow at most twice the number, which
  is still a number. On a route that also authenticates, the throttler is
  listed first, so a burst is counted before any token is checked. The 429
  says "Too many attempts. Wait a few minutes and try again.", not the
  throttler's default, which names a class. TAY's Redis fallback storage is
  not copied: with no Redis there is nothing to fall back from.
  *Corrected in C8-3: the counts are stored in Postgres, not in memory,
  and a 429 carries `Retry-After` (see* Rate limits*).*
- **An e2e test that calls a throttled route sends its own
  `X-Forwarded-For` address** (`test/staff-auth.e2e-spec.ts` makes a fresh
  one per call). Every request from the harness otherwise shares one
  address and one count, so a suite would start answering 429 on its
  eleventh sign-in, for a reason that has nothing to do with the test.
- **A test that asserts something is never logged switches the app to
  `StructuredLogger` first.** The testing module's logger drops everything
  below error, so "nothing was logged" would pass with no logger at all; the
  TAY-cookie test also asserts that an expected line did appear, so the
  capture is known to be live.
- **`staff.save` changes only the fields it is sent; the status changes
  only when `isActive` is sent** (plan §17, R2). The demo set an account
  Active whenever no status came with the save, so a name fix silently
  re-enabled a deactivated person.
- **`staff.save` revokes every refresh token the account holds when its
  role, email or status changes, inside the command's transaction** (A14).
  The guard refuses a deactivated or re-roled account on its next request
  anyway; revoking means no refresh can mint a session for the old state
  either, and a change that rolls back leaves the sessions as they were.
  A name correction ends nothing.
- **A new staff account gets a temporary password from
  `generateTemporaryPassword`, returned once in the create response, and
  must change it at first sign-in, exactly as the admin reset does.** One
  way to hand over a password, so the sign-in and forced-change screens
  serve both; it is never stored in plain text, logged or audited.
- **The staff QR token is minted only by `generateQrToken`, and reissuing
  it (`POST /staff/people/:id/qr/regenerate`) changes the token alone: the
  staff number and attendance are kept** (D44, Q12). A Manager or Owner ID
  is reissued only by the Owner, as every other change to such an account
  is. Neither the token nor any part of it is ever returned or audited;
  the audit row records `qrRegeneratedAt`.
- **A staff ID card (`GET /staff/me/card`, `GET /staff/people/:id/card`)
  carries the QR code only as `qrSvg`, rendered on the server by
  `renderQrSvg` (`src/common/qr-svg.ts`) from `staffQrPayload`
  (`src/staff/staff-qr.ts`): `CNC-ID:<staff number>:<qrToken>`.** A token
  in a JSON body ends up in a log, a cache or a screenshot of the network
  panel; a picture is readable only by a camera pointed at it. The payload
  is the staff app's own `staffCode` shape (its staff id was the staff
  number), so printed cards and the scanner stay one format, and the
  attendance scan (C5-7) parses exactly this through the same module.
- **The sweep routes (`/internal/sweeps/*`) sit behind `SweepTokenGuard`
  alone: `x-sweep-token`, compared in constant time with
  `CncConfigService.sweepToken`, one 401 sentence for absent, wrong and
  unconfigured, and every call refused when no token is configured.** They
  are excluded from Swagger and never throttled. Cloud Scheduler is not a
  staff member, an unset secret must never mean an open route, and a wrong
  token costs a string comparison before any query runs.
- **No behaviour may depend on a sweep having run.** Every rule a sweep
  tidies after is enforced where the row is used (a refresh token is
  refused once expired, a code after `expiresAt`, an idempotency key only
  replays its own answer). Cloud Run scales to zero and a Scheduler job can
  fail; a sweep that became the mechanism would leave the rule broken on
  exactly those nights.
- **The tokens sweep deletes by expiry, never by revocation: a revoked
  refresh token stays until it expires.** It is the record that a session
  was ended, and the refresh route answers the same 401 for revoked as for
  unknown, so deleting it early changes nothing a caller sees and loses the
  record (TAY's rule).
- **One-time code rows are kept `OTP_RETENTION_HOURS` (24) past their
  expiry before the tokens sweep deletes them.** The customer sign-in's
  issuance caps (C6) count those rows; deleting them the moment they
  expire would let a caller reset their own count by waiting out a code.
  A cap window longer than a day must raise the constant with it.
- **The credential limits count the account, not the address; this
  replaces the per-address counts in the throttling rule above**
  (`src/auth/auth-throttle.ts`). Sign-in counts the submitted email at the
  caller's address (10), the email from every address (30) and the address
  over every email (100); change-password and the admin reset count the
  signed-in account (10); refresh counts the address only (600). Every till,
  tablet and phone in the venue reaches Cloud Run from one public address,
  so per address the eleventh person at a shift change was refused, a guest
  on the Wi-Fi could lock the whole building out with ten bad sign-ins, and
  about thirty devices refreshing began signing people out. The windows
  (15 minutes), the in-memory count (A18) and the 429 sentence are TAY's
  and unchanged. Each route takes its decorator from `auth-throttle.ts`
  (`SignInThrottle`, `SignedInCredentialThrottle`, `RefreshThrottle`),
  which names all three counts the module registers, because a route under
  the guard runs every registered count it does not skip.
- **On change-password and the admin reset, `CncStaffGuard` runs before the
  throttler; this replaces "the throttler is listed first" above.** The count
  is the account the guard verified (`signedInStaffTracker`, which throws if
  the guard has not run). Counted before the token was checked, requests
  with no token used up the venue's attempts and blocked forced first
  changes; counted on the token's unverified `sub`, a forged token could
  spend a named person's attempts. A request without a valid token cannot
  guess a password, so nothing is lost by refusing it uncounted.
- **A refresh that carries the refresh cookie's name more than once is
  refused (401), spends neither token, and clears both copies**
  (`readRefreshCookie`, `clearShadowingRefreshCookies`). Any other
  `tayxcnc.com` host can set a cookie of the same name at
  `Domain=.tayxcnc.com`, and the browser sends the one with the longer path
  first, so reading the first would let that host pick the session: its own
  token, and the person at the till works as another account. The planted
  copy is cleared at `Domain=tayxcnc.com` on every prefix of the refresh
  paths; CNC still never sets a cookie with a `Domain`.
- **A rotated refresh token presented again more than
  `REFRESH_REUSE_GRACE_MS` (10 s) after its rotation ends every session of
  its subject** (`CncTokenService.redeemRefreshToken`; `RefreshToken.rotated`).
  The browser keeps only the newest token, so an older one comes back only
  as a copy; without this a thief who refreshed first kept a self-renewing
  session while the real person saw an ordinary sign-out. The grace window
  is the two-tab race. A token revoked by a sign-out or an account change
  (`rotated` false) is stale, not copied, and ends nothing.
- **Correction to the staff ID card rule above: the SVG keeps the QR token
  out of a text field, not out of the response.** Any QR library decodes it
  from the body, so the card is a credential: both card routes answer
  `Cache-Control: no-store`, and a Manager's or the Owner's card opens only
  for the Owner and its holder (`MoneyControlService.mayReadCard`, "Only the
  Owner can open a Manager or Owner Staff ID."). The demo showed every card
  to every manager; once the attendance scan (C5-7) exists, a decoded card
  clocks its holder in and out, and Manager and Owner accounts are the
  Owner's (plan §5.4).
- **Whether the refresh cookie carries `Secure` is
  `CncConfigService.secureCookies` (`NODE_ENV=production`), never a check
  written at a call site.** Staging runs `NODE_ENV=production` with
  `CNC_ENV=staging`, so a check on `cncEnv` would drop `Secure` on staging
  while every e2e suite (`NODE_ENV=test`) still passed; the getter's spec
  fails if it moves.
- **Customers sign in by email only** (Q5's default; from C6): `POST
  /auth/code` mails a 6-digit code, `POST /auth/verify` checks it, creates
  the customer on first use and starts the session, `POST /auth/refresh`
  restores it from `cnc_refresh_token`, `POST /auth/sign-out` ends every
  customer session. A phone number at `/auth/code` is refused with the
  sign-in screen's own sentence, "Enter your email address."; SMS sign-in
  waits for an SMS provider (Q5, Q19).
- **The customer realm is `CncCustomerGuard` and `@CurrentCustomer()`
  (`src/auth/`), the mirror of the staff guard: a `CUSTOMER` token whose row
  still exists.** A staff token on a customer route is `403` ("This route
  is for customers. The token presented is a staff token."), a customer
  whose row is gone `401`. Each realm's refresh redeems only its own
  `SubjectType`, and a token of the other realm is refused without being
  spent, so a customer cookie sent to the staff route signs nobody out.
- **The code is issued and checked only by `OtpService`
  (`src/customers/otp.service.ts`), purpose-generic so the email change
  (C6-3) shares its caps and sentences.** One-time code rules, with the
  numbers in `src/customers/one-time-code.ts`:
  - 6 digits from `crypto.randomInt`, stored as a keyed digest
    (`codeHash`: HMAC-SHA256 under a key derived by HKDF from
    `CNC_JWT_SECRET` with its own label, `otpCodeHash`, `deriveKey`),
    10 minutes, 5 tries (A15); the code is in no response and no log line.
    **Never a bare SHA-256** (from the C6 review): six digits are a million
    values, so anyone who read an unkeyed digest from the database (a
    backup, a support query, a dump) would recover a live code by hashing
    them all in under a second and sign in as that customer. Codes stored
    before the change expire within ten minutes, so it needed no migration.
  - **A long cap on wrong tries (from the C6 review): no new code for an
    email whose codes took 25 wrong tries in 24 hours**
    (`OTP_DAILY_FAILED_LIMIT`, counted on the stored rows, any purpose;
    429 "Too many attempts…"). The fifteen-minute caps alone let a patient
    guesser make about 2,400 guesses a day (some 7% a month at one in a
    million each); with it about 30 a day. The window sits inside the day
    the tokens sweep keeps the rows (`one-time-code.spec.ts`).
  - **Known and accepted: a stranger who knows an email can hold its
    sign-in back** by asking for codes and spending their tries, whatever
    the numbers, because every per-email cap counts requests anyone can
    make. A cap per requesting address instead would let a script on many
    addresses fill a stranger's inbox, which the per-email cap exists to
    stop; the inbox wins. The owner is told "Too many attempts…" and can
    still book as a guest.
  - **Caps count the stored `OtpCode` rows, not memory**: another code for
    the same email only after 30 s ("Please wait N seconds before asking
    for a new code.", 429, the account app's sentence); at most 5 codes per
    email and 30 per client address in 15 minutes ("Too many attempts. Wait
    a few minutes and try again.", 429). Rows hold across instances and
    restarts, where A18's in-memory throttler is per instance; the tokens
    sweep keeps them a day for this. 5 per email holds what a stranger can
    push into someone's inbox to twenty an hour; 30 per address leaves room
    for a mobile carrier's NAT or the venue's Wi-Fi.
  - Issuance for one email runs under `pg_advisory_xact_lock` on
    `cnc:otp:<purpose>:<email>`, so requests arriving together cannot both
    pass a cap (seen failing without it).
  - **Only the email's newest code counts**; a new one supersedes the old,
    as in the account app. The sentences are the app's, byte for byte: "Ask
    for a new code.", "That code has expired. Ask for a new one.", "That
    code is not right. N tries left." ("1 try left."), "Too many attempts.
    Ask for a new code.", all 400; a malformed code is "Enter the 6 digit
    code." (the screen's sentence with the server's six).
  - A wrong code spends a try by one conditional increment; the right one is
    spent by one conditional update (`consumedAt IS NULL`, unexpired, tries
    left) inside the transaction that creates the customer, so two verifies
    of one code cannot both sign in (seen failing without the condition),
    and a failure after it leaves the code unspent.
  - The in-memory throttles are the first line only: `/auth/code` counts the
    address (100), `/auth/verify` uses `SignInThrottle` (the email at an
    address 10, the email anywhere 30, the address 100), `/auth/refresh`
    `RefreshThrottle`. Every route runs against the one `ThrottlerModule`
    `CncAuthModule` registers: that module is `@Global`, so a second
    `forRoot` would replace these counts for every route instead of adding
    its own.
- **A customer is created only by `CustomerService.findOrCreateVerified`,
  under `pg_advisory_xact_lock` on `cnc:customer-email:<email>`**, drawing
  the member number only when it creates. Two first sign-ins with one email
  (or, from C7, a sign-in racing checkout's "Save my details") make one
  customer, never a unique-index 500, and returning customers burn no
  numbers. A new customer's name is empty, and `isNew` is "no name yet"
  (the account app's `isNew || !name`), so a person who closed the name
  step is asked again.
- **Customer sign-in writes no audit row**, as staff sign-in writes none:
  it is not a command in the staff app's record. The code row keeps who
  verified (`customerId`), from which address and when.
- **Customer sign-out ends every customer session, as TAY's member
  sign-out does**: a refresh token carries no id a client could name, so
  one-device sign-out would be a token-service change.

## Rate limits *(from C8-3)*

- **Every rate-limit count is stored in Postgres (`RateLimitCount`,
  written only by `RateLimitStore.hit`), never in memory; this replaces
  plan A18's in-memory counting.** `RateLimitStore` is the storage of the
  one `ThrottlerModule` (`cnc-auth.module.ts`), so every `@Throttle`
  count is stored with no change to the decorators. An in-memory count is
  per instance: each Cloud Run instance gave a caller the whole number
  again, and a restart or a scale-to-zero forgot it, so a limit was a
  number times however many instances happened to run. The stored caps
  that already counted rows (codes, bookings, enquiries) are unchanged.
- **One count is one atomic `INSERT … ON CONFLICT DO UPDATE` on the key's
  row, timed by the database's clock, in a fixed window**: the first
  request opens a window; the request over the limit is refused and
  blocks the key for the window; blocked requests are refused and not
  counted; the next request after the block opens a new window. The
  row's lock orders requests arriving together on any instance, so none
  is lost (25 at once against a limit of 10 allow exactly 10, in the
  e2e suite), and one clock means instances cannot disagree about a
  window. A fixed window lets a burst at the end of one window and the
  start of the next through together, at most twice the number; that is
  still a number, and it needs no second row per key.
- **The key is a digest: `<namespace>:<sha256>` of the throttler's own
  key (the route, the named count and who is counted) or of a hand-made
  key.** No row holds an address or an email in the clear. The namespace
  is `cnc` for the service (`RATE_LIMIT_NAMESPACE`); the e2e harness
  gives each test app its own, because the suites share one database and
  run minutes apart, and a count left by one would refuse another's
  requests (`createTestApp({ rateLimitNamespace })` makes two apps one
  deployment, which is how the cross-instance test works).
- **Cost: each counted request is one more write on the shared pool, so
  only writes are counted** (and the one read that may call Paystack).
  The public reads stay unthrottled. There is one row per caller per
  count per route, so a flood from many addresses is many small rows
  until the sweep. The tokens sweep deletes rows whose window and block
  have both ended (`rateLimitCounts` in its answer); an ended row it has
  not reached is a fresh window, so nothing depends on the sweep. Every
  venue device refreshing from one address meets on one row, whose lock
  is held for one statement.
- **A refusal costs no database round trip once this instance has seen
  the key blocked: `RateLimitStore` remembers each blocked key until its
  stored block ends and answers 429 from memory** (C8 review). Without it
  every request of a flood at a public write (codes, bookings, enquiries,
  checkouts, the quote, bad webhook signatures) still took one of the
  three pooled connections the till needs, on the instance shared with
  TAY, so a limit no longer shed load. The block's end is the database's,
  carried over as a duration onto the process's monotonic clock
  (`performance.now()`, which the e2e fake clock leaves real), so a block
  never ends early on any instance; at most 10,000 keys are remembered
  (`BLOCKED_KEYS_REMEMBERED`), ended ones first out, and a key past the
  cap is still refused by its row. *Known limit:* many addresses, each
  under its limit, are still one write per request; stopping that is the
  edge's work (a load balancer or Cloud Armor rule), not the
  application's, and belongs with production's hardening.
- **Every 429 from a throttle answers "Too many attempts. Wait a few
  minutes and try again." and carries a standard `Retry-After` in whole
  seconds** (`ClientAddressThrottlerGuard`, beside the throttler's own
  `Retry-After-<count>`; the webhook sets it by hand). CORS exposes it
  (`CORS_EXPOSED_HEADERS`), so a page on an allowed origin can read it.
  *Decision:* the stored caps that count rows (the code caps, the daily
  booking caps, the hourly enquiry cap) keep their 429 without
  `Retry-After`: their honest wait is when the oldest counted row leaves
  the window, which they do not compute, and the code's resend gap
  already says its seconds in the sentence.
- **The Paystack webhook counts only deliveries with a bad signature,
  per address, 120 a minute, after the signature is checked; a correctly
  signed delivery is never counted or refused for volume.** Only Paystack
  holds the key, a replay of the same bytes changes nothing (the
  `PaymentEvent` ledger), and the payments and checkouts sweeps re-verify
  with Paystack, so refusing a signed delivery could only delay a payment.
  Past the number a bad delivery is answered 429 with `Retry-After` and
  no log line, so a flood of forgeries cannot fill the log. A throttler
  guard is not used on the route, because a guard counts before the
  handler checks the signature.
- **A signed-in customer's write is counted per customer, after
  `CncCustomerGuard` (`CustomerWriteThrottle(limit, ttl)`)**, never per
  address: customers share the venue's Wi-Fi and their carriers' NAT, and
  counting after the guard means a request without a valid token is
  refused uncounted and nobody can spend another customer's count. The
  photo upload is counted by the guard before the upload interceptor
  reads the file.
- **A signed-in staff member's push subscription write is counted per
  person, after `CncStaffGuard` (`StaffWriteThrottle(limit, ttl)`,
  `signedInStaffTracker`; from C10)**, `CustomerWriteThrottle`'s staff
  twin: every device in the venue shares one address, so a count per
  address would let one tablet spend everyone's, and counting after the
  guard means a request without a valid token is refused uncounted.
- **The routes and their limits.** Windows are fifteen minutes unless
  said. "Stored caps" count the records themselves. Staff routes behind
  `CncStaffGuard` are not limited (a staff command needs a signed-in
  account, and a global guard would put every staff read under a
  sign-in limit), except the two credential routes and the push
  subscription routes below.

  | Route | Caller | Limits | Why this number |
  | :--- | :--- | :--- | :--- |
  | `POST /auth/staff/sign-in` | anyone | the email at one address 10; the email from anywhere 30; the address over every email 100 | per account, not per address: the whole venue is one address (*Auth*) |
  | `POST /auth/staff/refresh` | anyone with the cookie | the address 600 | a refused refresh signs a real person out; the token cannot be guessed |
  | `POST /auth/staff/change-password` | staff | the signed-in account 10 | counted after the guard, so nobody spends another's tries |
  | `POST /staff/people/:id/reset-password` | managers | the signed-in account 10 | as change-password |
  | `POST /auth/code` | anyone | the address 100; stored caps: 30 s between codes per email, 5 per email and 30 per address, no code after 25 wrong tries in a day | the inbox and the guess rate (*Auth*, codes) |
  | `POST /auth/verify` | anyone | as staff sign-in (10, 30, 100); 5 tries per code | the guess rate |
  | `POST /auth/refresh` | anyone with the cookie | the address 600 | as staff refresh |
  | `POST /auth/sign-out` | customer | the customer 30 (new) | a state-changing route stays a number |
  | `PATCH /me` | customer | the customer 30 | a phone number cannot be tested as a list |
  | `POST /me/email/code` | customer | the address 100; the code caps | as `/auth/code` |
  | `POST /me/email/verify` | customer | as `/auth/verify` | as `/auth/verify` |
  | `POST /me/photo`, `DELETE /me/photo` | customer | the customer 20 each (new) | decoding and resizing is the dearest thing a customer can ask for |
  | `DELETE /me` | customer | the customer 10 (new) | it succeeds once; this stops a refused one looping |
  | `POST /me/notifications/read` | customer | the customer 120 (new) | far above opening the list |
  | `POST /me/push/subscriptions`, `DELETE /me/push/subscriptions` | customer | the customer 30 each (`PUSH_SUBSCRIPTION_LIMIT`, C10) | a page load syncs the device once, so 30 covers re-opening the app all day; more is a script probing endpoints |
  | `POST /staff/push/subscriptions`, `DELETE /staff/push/subscriptions` | staff | the signed-in account 30 each (`STAFF_PUSH_SUBSCRIPTION_LIMIT`, C10) | as the customer's, counted per person because the venue's tablets share one address |
  | `PATCH /me/reservations/:id`, `POST …/cancel` | customer | the customer 30 each (new) | each emails and takes the table's lock |
  | `POST /ordering/quote` | anyone | the address 120 (new) | four times the checkouts one address may make |
  | `POST /checkouts` | anyone or customer | the address 30 | each is a Paystack call on CNC's account |
  | `GET /checkouts/:reference` | anyone with the reference | the address 300 a minute | a read that may call Paystack's verify |
  | `POST /reservations` | anyone or customer | the address 30; stored caps: 20 a day per address, 10 a day per email | holds a table for a date and sends an email |
  | `POST /enquiries`, `POST /group-enquiries` | anyone | the address 20 per form; stored cap: 5 an hour per address across both | each is an email into CNC's inbox |
  | `POST /payments/webhook` | Paystack | bad signatures per address 120 a minute; signed deliveries never | see above |
  | `POST /internal/sweeps/*` | Cloud Scheduler | none (`SweepTokenGuard`) | not a person; a wrong token costs a comparison |
  | `POST /auth/staff/sign-out` | staff | none | staff-authenticated, as every staff command |

- **`test/rate-limits.e2e-spec.ts` proves each new number and the stored
  behaviour**: two apps on one namespace share a count and a restarted one
  still refuses; requests together are counted once each; a block ends in
  a fresh window; every limit above without an earlier test answers 429
  with the sentence and a `Retry-After` within its window; signed
  webhook deliveries far past the ceiling are all accepted and recorded
  once, and a signed delivery lands from an address its bad signatures
  have blocked; no key holds an address. The older suites keep their own
  limits' tests (`staff-auth`, `customer-auth`, `customer-account`,
  `customer-reservations`, `enquiries`).

## Mail and the outbound queue *(from C6)*

- **Every email goes through `OutboundMessagesService` (`src/mail/`):
  `enqueue(tx, …)` writes an `OutboundMessage` in the command's own
  transaction, and `dispatch(id)` sends it after the commit.** A failed
  send never rolls back a command and never fails a customer's request
  (plan §4.8): the message waits for `POST /internal/sweeps/messages`.
  `dedupeKey` (`otp:<OtpCode.id>`, later `reservation:<id>:confirmed` and
  the like) is inserted with `ON CONFLICT DO NOTHING`, because a P2002
  inside the caller's transaction would abort the command.
- **The row stores the template's name and its parameters, sealed, never a
  rendered body** (`payload`, AES-256-GCM under a key derived by HKDF from
  `CNC_JWT_SECRET` with its own label, `MessageSeal`). The queue must be
  able to re-send a sign-in code, so the code is stored until then; in
  clear, a database read would yield a working code and undo `codeHash`.
  The payload is cleared once the message is sent or given up. A new secret
  was not added: it would need a Secret Manager entry and deploy change on
  every environment, for a value only this service must hold. Rotating the
  JWT secret makes waiting payloads unreadable, and the queue gives those
  messages up.
- **A template is rendered at send time, and its parameters are checked
  by a guard when read back** (`mail-templates.ts`); `enqueue` renders once
  and discards, so a misfit fails the command at once, not silently in a
  sweep. Every caller-supplied value goes through `escapeHtml`.
- **Every message has an `expiresAt`; past it the sweep gives up**
  (`FAILED`, "Expired before it could be sent."). A code's email expires
  with the code; others default to 24 hours. A confirmation days late is
  worse than none, and a staging service without a key would otherwise
  send its whole backlog the day the key is set.
- **Three attempts, claimed by a conditional increment of `attempts`
  before each send**, so the request's dispatch and a sweep at the same
  moment cannot both send one message. **While mail is not configured, a
  message waits `PENDING` without spending an attempt** (`lastError` "Mail
  is not configured.").
- **The claim is a lease (from the C6 review): it also moves `retryAfter`
  `MESSAGE_SEND_LEASE_MS` (2 minutes) ahead**, so a sweep that starts
  while the request's own send is still in flight skips the row; the
  claim alone did not cover that, and the sweep claimed the next attempt
  and sent a second copy (`customer-messages` races the two with a slow
  transport, `RecordingMailTransport.hold`; seen failing without the
  lease). A process that dies mid-send leaves the lease to run out and the
  sweep tries again. **A failure is written only by the claim that made it
  (`attempts` still the claimed value) and never over `SENT`; a success is
  written whichever claim made it.**
- **Every send carries the message's row id as Resend's idempotency key
  (`OutgoingMail.idempotencyKey`) and gives up after `MAIL_SEND_TIMEOUT_MS`
  (20 s)**, shorter than the lease. A hung provider would otherwise hold a
  customer's request (`POST /auth/code` dispatches after its commit) for as
  long as it hangs, and a retry after a lost answer is then recognised by
  the provider instead of delivered twice.
- **The transport is chosen once by `CNC_ENV`** (`mailTransportFor`):
  locally, and in every test, `RecordingMailTransport` sends nothing and
  writes the text, code included, to the local log, so a local walk reads
  the code from the server's output and no local run can send real mail
  even with a real key. Staging and production use `ResendMailTransport`
  with CNC's own key, which logs the recipient and the outcome only, never
  a subject or body (TAY's rule: a body in a log line is a credential in a
  log line). A built container refuses `CNC_ENV=local`, so the logging
  transport cannot reach a deployed service.
- **`CncConfigService.resendApiKey` and `mailFrom` read a placeholder
  (`PLACEHOLDER_NOT_SET`, `CHANGE_ME`) as unset.** Staging carries the
  placeholder until the founder's Resend steps; handed to Resend it would
  make every send a failure that burns a retry.
- **On a transport that reaches real inboxes (`deliversToInboxes`:
  Resend), a message to a reserved domain is given up unsent, with no
  provider call and no attempt spent** (`isReservedMailDomain`:
  `example.com`, `.net`, `.org` and every `.test`, `.example`, `.invalid`
  and `.localhost` name, RFC 2606 and 6761; `lastError` "Not sent: the
  address is at a reserved domain that cannot receive mail."; C8 review).
  Such an address can only bounce: the load test's guests are
  `@example.com`, and people trying staging type `test@example.com`, so
  each send would spend CNC's Resend quota and count as a hard bounce
  against its sending domain. The recording transport says false, because
  every suite mails `.test` addresses and reads them back.
- **The e2e harness replaces the transport with a `RecordingMailTransport`
  that logs nothing; a suite reads mail with `sentMail(app)`** and takes a
  code from the email's text, as a customer would. Its `configured`,
  `failWith` and `deliversToInboxes` switches stand in for an unconfigured,
  failing or real provider.
- **The mail frame is `cnc-mail-frame.ts`: TAY's table structure, CNC's
  colours (`cnc-frontend/app/globals.css`), the wordmark "CHEF NORO
  CULINARY" and the site's icon from `buildWebUrl('/icons/icon-192.png')`**
  (plan §9.2). With no web URL it shows the wordmark alone.

- **Every email carries Reply-To `CNC_CONTACT_EMAIL`** (from C6-3,
  `OutboundMessagesService`). The sender `cnc@mail.tayxcnc.com` only sends
  (Q19), so a customer's reply would otherwise reach no inbox; the
  founder's 2026-10-22 note asked for it.
- **The sender is on `mail.tayxcnc.com`, the domain verified with Resend,
  never on `tayxcnc.com` itself** (`CNC_MAIL_FROM`, 2026-10-26). Resend
  refuses a sender on a domain the key is not authorised for ("API key not
  authorized for this domain"), the send fails, and the queue retries it to
  the same refusal. Staging's first sign-in codes were lost this way.
- **A template may name its own Reply-To (`RenderedMail.replyTo`); only the
  enquiry emails do, with the sender's address** (from C6-7). They go to
  CNC's inbox, so the default would make Reply answer CNC itself; with the
  sender's address CNC answers by pressing Reply (TAY's contact mail). A
  large-group request without an email keeps the default.
- **A failed send waits before its next attempt: 5 minutes after the
  first, 30 after the second (`MESSAGE_RETRY_BACKOFF_MS`,
  `OutboundMessage.retryAfter`)** (from C6-8). The sweep runs every five
  minutes, so without a wait one short provider outage would spend all
  three attempts in a quarter of an hour and give the message up; with it
  the three span more than half an hour, well inside a message's day.
  Every dispatch honours the wait, a replayed command's included. The wait
  is cleared once the message is sent or its last attempt is spent. An
  unconfigured transport sets no wait and spends no attempt, as before.
- **The messages sweep and the reminders sweep are the queue's only
  timers, and both are Cloud Scheduler jobs** (*Infrastructure*): nothing
  in the service retries on its own clock, because Cloud Run scales to
  zero and an in-process timer dies with the instance.

## The customer's account *(from C6)*

- **`PATCH /me` takes the name, the phone, the whole address and the
  preferences, each only when sent; never the email or the photo**
  (plan §5.2), which have their own routes because one needs a code and
  the other is a file. It runs in one transaction on the customer's row
  locked `FOR UPDATE` (`CustomerService.lockLive`), so a rule spanning two
  fields (keep a phone or an email) holds when two of the customer's
  devices save at once.
- **The sentences are the account app's where it has one**
  (`lib/account/api.ts`, `components/account/panels.tsx`), byte for byte:
  "Enter a Nigerian phone number, for example 0803 123 4567.", "Keep at
  least a phone number or an email.", "Add the street, area and town.",
  "Add an email address in Your Details to receive updates by email.".
  Each new one is marked new in `profile-rules.ts` with its reason.
- **A phone is stored as `0` plus 10 digits however it was typed**
  (`customerPhone`, the app's `normalisePhone`); null or blank removes it.
  `Customer.phone` is unique, so the second account to save a number gets
  409 "This phone number is already on another CNC account." rather than a
  500.
- **`PATCH /me` is counted per customer: 30 saves in 15 minutes
  (`ProfileSaveThrottle`, `signedInCustomerTracker`, listed after the
  controller's `CncCustomerGuard`)** (from the C6 review). The 409 above
  says whether a number is a CNC customer's, so without a number one
  account could test a list of them. Thirty covers a person flipping every
  Notifications switch twice. **Still open, for the founder:** an
  unverified number saved first blocks its real owner, because the plan
  makes `Customer.phone` unique (§4.2) and phones are never verified while
  there is no SMS (Q5, Q19). Unique only among verified phones would end
  that; it waits for phone verification, with the SMS provider.
- **A delivery address is one shape for the profile and checkout:
  `src/common/delivery-address.ts`** (zone `JOS`/`PLATEAU`, street, area,
  town, landmark; the landmark required by D53, each line at most 120
  characters). C7's checkout uses the same module, so a saved address is
  always one checkout accepts. The address is sent whole, or null to
  remove it; it is checked with one sentence per screen (`@Checked`),
  never nested validation, whose messages carry a field path.
- **Offers stay off and SMS stays unavailable until the founder turns them
  on** (plan §4.2; Q5 and Q19's defaults): `offers: true` and `channel:
  SMS` are refused with their own sentences rather than stored as promises
  nobody keeps. A switch is judged only when sent, so a screen that sends
  every switch with offers off is never refused for it.
- **The email changes in two steps: `POST /me/email/code` mails a code to
  the new address, `POST /me/email/verify` checks it and moves the
  account.** The account keeps its email until then, so a typo locks
  nobody out. The code is `OtpService`'s with purpose `CHANGE_EMAIL` and
  the sign-in's caps, tries and sentences; it is issued for the asking
  customer and only that customer can verify it (`customerId` on
  `OtpService.verify`; seen failing without it). Whether another account
  holds the address is said only at verify, after the code proves the
  inbox (409), so the route cannot be used to learn which emails have
  accounts. The verify takes the email's advisory lock, as a first
  sign-in does. The old address is told, with the new one masked;
  sessions are kept.
- **The customer's photo is a 256-pixel square** (A17, `PHOTO_SHAPES`),
  through `PhotoStore` in the staff photo's order: stored before the
  transaction, the old object removed after the commit, the new one
  removed if the write fails. `POST /me/photo` carries no `version`:
  `Customer` has none (A8 does not list it; only its holder edits it).
- **Every `/me` answer is `Cache-Control: no-store`**: personal data must
  not outlive a sign-out in a shared cache or the back button.
- **Deleting an account (`DELETE /me`, Q36) anonymises, never erases.**
  The row stays with `deletedAt` set, because bookings, bills and the
  audit log point at it and money records are never deleted. In one
  transaction: the name, email, phone, address, photo and preferences are
  cleared; the account's bookings become "Deleted customer" with no
  phone, email or note, and its bills' guest name likewise (their
  `version` moves, so an open screen is told to refresh); its
  notifications, codes and stored idempotent answers are deleted; every
  waiting email to it is given up; every session is revoked and the
  cookie cleared. A CHECK (`Customer_deleted_check`) refuses a deleted
  row that keeps or regains a contact or an address. The guard, the
  refresh and every `CustomerService` read treat a deleted account as
  gone (401). The same email then signs in to a new, empty account. **It
  is refused (409) while a booking the customer made in the app (`APP`)
  holds a table on a date from today on, or a linked bill is open**: an
  anonymised upcoming booking would leave Reception a table held for
  nobody. The audit log keeps what it recorded (A13). *From C8-5: what
  carries the verified email unlinked is forgotten too, stored answers
  naming the records are removed, and the audit read withholds the guest's
  values; see* Data retention and account deletion.
- **An upcoming website or Reception booking linked to the account by its
  email or phone (Q35) does not refuse a deletion: it is unlinked and kept
  as the guest booking it was made as** (from the C6 review). Anyone can
  type someone's email into the website's form, and a booking under 24
  hours away cannot be cancelled online (Q6), so counting those let a
  stranger block a person's deletion every day. Unlinked, it keeps the
  name and number Reception greets and calls.
- **Deletion forgets the account's messages too
  (`OutboundMessagesService.forget`): every `OutboundMessage` to its
  address, and every one whose dedupe key names its bookings
  (`reservation:<id>:…`) or its codes (`otp:<id>`, `email-changed:<id>`),
  loses its recipient and payload; those still waiting are given up**
  (from the C6 review). A sent message's `to` beside a booking id in its
  key named the person an anonymised booking belonged to, which undid
  Q36; the key match also reaches addresses the account had before an
  email change. The codes are read before they are deleted, for this.
  Both booking notes are cleared (`note`, `guestNote`).
- **"Holding" and "unsettled" are one list each:
  `HOLDING_STATUSES` (`reservation-rules.ts`) and
  `UNSETTLED_ORDER_STATUSES` (`order-rules.ts`)**, read by the booking
  command, the floor, the public availability, the table release and
  account deletion, so no two of them disagree about what holds a table
  or keeps a bill open.

## Data retention and account deletion *(from C8-5)*

- **Q36's periods are the founder's standing default: enquiries are kept
  12 months, attendance 2 years** (`ENQUIRY_RETENTION_MONTHS`,
  `ATTENDANCE_RETENTION_YEARS` in `src/internal/retention-sweep.service.ts`,
  the one place they are written). The Nigeria Data Protection Act 2023
  asks for a stated retention, and a number written twice drifts.
- **`POST /internal/sweeps/retention` (`RetentionSweepService`, behind
  `SweepTokenGuard`) deletes enquiries made before the start of the same
  Lagos date 12 months ago, and finished shifts dated before the same date
  2 years ago, with their corrections.** Lagos dates, because every period
  a person reads here is a Jos day. A date the earlier year lacks (29
  February) rolls forward, so a row is kept a day longer, never deleted a
  day early.
- **What references the rows was checked before any delete:** nothing
  references an `Enquiry` (its email to CNC's inbox keeps only CNC's own
  address once sent); an `AttendanceRecord` is referenced only by its
  `AttendanceCorrection` rows, which cascade with it; the audit log names a
  scan or correction by the person's staff number, never by the record, so
  every audit read stays whole. **The audit log is append-only and is never
  swept** (A13), and neither is any money record.
- **An open shift is never deleted, however old.** It is the state the
  person's next scan acts on (it closes it), and the partial unique index
  allows one per person; deleting it would change what a scan does.
- **From C10 the same sweep deletes web push rows written more than 30
  days ago, in any status, and push devices in either realm neither
  subscribed again nor delivered to for 180 days**
  (`PUSH_MESSAGE_RETENTION_DAYS`, `PUSH_SUBSCRIPTION_UNUSED_DAYS`;
  `greatest("lastSeenAt", coalesce("lastSuccessAt","lastSeenAt"))` before
  the cutoff). A push row is a delivery record, not a history: the in-app
  list and the bell are the history, and a month answers "did that push
  go?". 180 days is what the account panel's privacy note promises, and
  browsers rotate a live subscription long before it, so one that quiet
  belongs to a browser nobody uses. Nothing references either table.
- **Batches of 500, at most 20 a table a run, each selecting ids and then
  deleting them with the cutoff repeated; idempotent; one sentence a run**
  ("Sweep retention deleted N enquiry(ies), M attendance record(s), P
  push(es) and D push device(s).", plus "; more remain for the next run."
  at the cap). A run's request
  stays short on a shared instance, a row written meanwhile can never be
  caught, and a second run the same day deletes nothing. Its Scheduler
  job (weekly) is in *Infrastructure*.
- **Deleting an account (`DELETE /me`) also forgets what carries the
  account's verified email without being linked to it**
  (`CustomerDeletionService.forgetUnlinked`): its enquiries are deleted,
  and its finished guest checkouts and web orders (placed before the email
  was verified, or without saving details) lose the person as linked ones
  do. The email was proved with a code, so these are the person's; a phone
  is never matched, because phones are not verified while there is no SMS
  (Q5). A guest order still active, or a checkout still waiting for or
  holding a payment, is left as it is and refuses nothing: anyone can type
  an email at checkout.
- **Deletion also removes stored Idempotency-Key answers that carry the
  account's email or name one of its records** (a Reception booking's
  create, an Online Orders edit, kept 7 days). The cost is only the replay
  of a request about a record that no longer names anyone; a retry comes
  within seconds, not after a deletion.
- **The audit log keeps what it recorded, so the read withholds it**
  (`AuditQueryService`): a row written by a deleted customer, or about a
  booking, a bill or a checkout that deletion anonymised, shows its
  customer actor as "Deleted customer" and each guest field
  (`CONTACT_FIELDS`: name, phone, email, notes, address, a bill's guest, a
  transfer's sender) as "<Field> not shown: the customer deleted their
  account." or "<Field> changed, not shown: …" (new sentences). The staff
  app's describeChange printed every value, so a manager reading a
  deleted guest's booking history would otherwise read their number. Free
  text a person typed into a `reason` cannot be told apart and is shown.
- **A checked-in booking's seating is anonymised with it, and its
  release row is withheld at the read** (C8 review). Check-in copies the
  booking's name into `TableSession.guest`, and `table.release` writes it
  into an audit row under the table's ref (`D-B1`), not the booking's, so
  matching by ref alone missed it. Deletion sets the seating's guest to
  "Deleted customer"; the release row carries `sessionId` (never
  described), and the read withholds the row when that seating's booking
  is anonymised. A release written before the row carried `sessionId`
  cannot be joined and is shown as recorded: only local and staging test
  data has one, as production had no guests yet. A transfer's sender (or
  refund recipient) on the deleted person's bills becomes "Deleted
  customer" too (*decision*: Daily Transfers still lists the payment, its
  amount and its bank reference, which is what matching it to the bank
  statement needs; the name is the guest's). A card payment's brand and
  last four digits stay: they identify no one without the bank.
- **What still holds a deleted person's details, by decision:** the audit
  log's rows (append-only, withheld at the read, above); a web docket's
  note (a docket revision is never changed; the founder's standing
  default); CNC's own inbox, where enquiries and held-payment alerts were
  emailed; and the rate-limit counts' keys, which are SHA-256 hashes and
  end with their window. `test/account-deletion.e2e-spec.ts` searches every
  other table for the person's email, phones, name and address after a
  deletion (a guest web order refunded by transfer, a cancelled booking
  and a booking checked in and released among them) and finds none.

## The public reads *(from C6)*

- **`GET /menu`, `/business`, `/opening-hours`, `/venues`,
  `/venues/:venue/availability`, `/ordering/config` and `/ordering/slots`
  need no sign-in and expose nothing internal**: no row ids, versions,
  staff names or labels, stock, costs, approval limits, guests, lock
  reasons or bills. Each answers its own public DTO, never the staff
  response with fields removed, so a field added to a staff read cannot
  leak. The e2e suite asserts each body's exact keys.
- **Caching: `PublicCache()` (`public, max-age=60`) for what changes only
  when staff change it** (the menu, business, hours, rooms, ordering
  config); **`no-store` for what depends on the minute** (availability,
  slots), because a cached "available" is a table someone has just booked
  and the gate asks for the website to follow Reception within one
  refresh. A minute keeps an Owner's price change on the site within a
  minute of the page's own revalidation (gate step 8). The public menu
  signs photo links for an hour (`PUBLIC_PHOTO_LINK_TTL_MS`), because a
  cached page outlives the storage's ten-minute default.
- **The menu shows only items that are Available for Sale and Show
  Online** (Q37's default: an unavailable dish is hidden, no "Sold out"
  state), in the customer categories' order; a category with nothing to
  show is left out.
- **A table's public state is Reception's floor rule (`floorStatus`) on
  the same rows**, with Locked named `BLOCKED` (plan §7.5; the site shows
  it as Unavailable). The arrival times offered are built by running
  `arrivalProblem` (the booking command's own check) over the grid
  (`arrivalTimes`), so every time offered is one the booking accepts.
  Inactive tables are not listed. Availability defaults to today in Jos
  and refuses an earlier date.
- **The ordering times are `src/ordering/ordering-times.ts`, pure, read
  from the settings and the opening hours** (plan §8.3, the website's
  `leadFor`, `asapOpen` and `laterSlots`): lead by pickup or zone; ASAP
  only while open now and now plus the lead is at most the last order
  slot; scheduled times on the grid from the day's opening, at least the
  lead after `max(now, opening)` today, every slot tomorrow, nothing past
  closing or the last slot. C7's checkout must judge a chosen time with
  these functions, so what is offered is what is accepted.
- **The public reads are not throttled.** They are cheap reads, the
  cacheable ones are served from caches, and the venue's Wi-Fi puts many
  guests behind one address, which an in-memory per-address limit (A18)
  would lock out together. *From C8-3 the counts are stored, which makes
  each counted request a database write; the reads stay unthrottled for
  that reason too. `POST /ordering/quote` is a write by method and now has
  a limit (see* Rate limits*).*

## Money controls and the audit log *(from C3)*

- **Every Owner-only, limit and own-record rule goes through
  `MoneyControlService` (`src/money-control/`), and its sentences are the
  exported constants there, never retyped** (plan §6.2). `ownerOnly` with
  `OWNER_ONLY_ACTIONS`, `requireOwner` with the price, new-item and
  settings sentences, `withinLimit` with `LIMITED_DECISIONS`, `notOwn` with
  `OWN_RECORD_KINDS` (and `notOwnCorrection` for a correction of an
  approved record), `mayChangeAccount` and `keepsAnActiveOwner` for staff
  accounts. The screens show these refusals verbatim (A7); one home per
  sentence is the only way two commands applying the same rule print it the
  same way.
- **A correction that raises an already-counted decision counts only its
  increase, through `increaseKobo` passed as `withinLimit`'s
  `countedKobo`, while `amountKobo` stays the whole new value for the
  per-decision limit** (`order.discount`, and from 2026-10-22 `waste.edit`
  and `purchase.edit` of an approved record). One helper, so "the increase
  only" is computed the same way wherever the founder has applied it.
- **A figure inside a ported sentence is formatted with `formatKoboShort`**
  (`src/common/money.ts`): whole naira with no decimals, otherwise two, as
  the staff app's `money()` prints. "…above the Owner Approval Limit of
  ₦50,000." is a byte-for-byte sentence, and `formatKobo`'s `₦50,000.00`
  would change it. Receipts and confirmations keep `formatKobo`.
- **`withinLimit` runs inside the command's transaction, before the
  command's own writes, and is the only writer of `ApprovalLedger`.** It
  takes `pg_advisory_xact_lock` on the manager and the Lagos business date,
  sums the day as `bigint`, refuses above the limit, and inserts the counted
  amount, all in that transaction. Read, then insert without the lock, and
  two approvals racing past the limit both see the old total; the e2e race
  test fails when the lock is removed. The ledger row commits with the
  decision it counts, or not at all.
- **Decisions are recorded in the ledger while the daily limit is off, and
  the Owner is never recorded** (D36). Switching the limit back on mid-day
  then counts the day's decisions already made, and the Owner has no daily
  limit to count against.
- **`ApprovalLedger` is append-only by trigger, like `AuditLog`, and an
  amount is always positive.** A deleted or lowered row is a manager's limit
  quietly raised. A refund counts by its size, so the writer stores the
  absolute amount. *Amended by C8-0 below: a release row is the one
  negative row.*
- **A decision whose money never moved is given back by a release row,
  never by touching the row that counted it** (C8-0, the founder's
  decision of 2026-10-24: a card refund Paystack refused, or one a manager
  resolves as not in Paystack's dashboard). The limit caps the money a
  manager moves in a day, and a refusal moves none. `withinLimit` answers
  the row it wrote, the refund keeps it (`OnlineRefund.ledgerEntryId`), and
  `releaseCounted` appends `online.refundRelease` with a negative amount,
  `releasesId` naming the row, and that row's person, business date and
  ref, in the transaction that records the refusal. So the day lowered is
  the day that counted it, whenever and by whomever the refusal is
  recorded, and the release commits with the refusal or not at all.
- **A release gives back at most what its row counted, and a row is
  released once** (`ApprovalLedger_amount_check` lets only a row with
  `releasesId` be negative; the unique `releasesId` and the
  `ApprovalLedger_release_shape` trigger refuse a second release, a larger
  one, one on another person, date or ref, and a release of a release).
  The service computes the amount, but only the database can stop a
  mistaken or concurrent writer; a release above its row would raise a
  manager's limit for unrelated decisions.
- **`releaseCounted` takes no ledger lock.** A release only lowers a day,
  so a decision summing that day while it commits sees the higher total
  and can at worst be refused, never pass above the limit; and taking the
  lock after the refund's own rows could deadlock against a decision that
  holds the lock and waits for those rows (`online.balance` settling the
  same adjustments).
- **`standing()` and `approvalRefusal` need nothing new for releases:**
  the day's `bigint` sum already includes the negative rows, so the
  Approvals screen predicts on what the manager actually moved.
- **A plain `TRUNCATE "ApprovalLedger"` now stops at the foreign keys that
  name its rows; the append-only test truncates with `CASCADE` to reach the
  trigger**, as the stock movements' test does. The trigger fires before
  anything is emptied, so the cascade empties nothing.
- **The last-Owner rule takes one advisory lock before it counts the other
  active Owners.** Two Owners demoting each other at once would otherwise
  both see the other still active and leave CNC with none. An advisory lock
  rather than `SELECT … FOR UPDATE` on the Owner rows, because a command
  that already holds its target row (`claimVersion`) would deadlock against
  another holding the other Owner's.
- **Every command writes its audit row with `AuditService.record(entry,
  tx)` on its own transaction; the transaction argument is required.** An
  audit row committed for a change that rolled back is a false record, and
  a change without its row is invisible (A6, A13). TAY's writer falls back
  to the base client; CNC's has no fallback to forget.
- **An audit entry's `action` is the staff app's command name
  (`order.settle`); the module is derived from it by the writer, and `ref`
  is the record's human reference** (an order or purchase number, a `KOT-`
  ref, a staff number, a menu slug). The screens file and filter history by
  those, and a module passed in by a caller could file a row under the
  wrong screen. New commands get a label in `audit-sentences.ts`.
- **`before` and `after` hold plain fields and never a credential;
  `AuditService` refuses a row that carries one** (`passwordHash`,
  `qrToken`, `tokenHash`, a password field…), at any depth. The table is
  append-only, so a secret written there could never be removed. Write a
  business date as `YYYY-MM-DD`; the sentences show `*Kobo` as naira,
  `*Bps` as a percentage and an enum value in words.
- **`GET /staff/audit` returns sentences, never `before` and `after`**
  (A13, D47): the response is built field by field (`toResponse`), so a raw
  column cannot ride along. The sentences follow `jsonb`'s key order
  (shortest key first), not the order the command wrote the fields.
- **A Manager's audit read hides other Managers' entries by the role on the
  row (`actorRole`), and keeps rows with no role** (plan §4.8). The role is
  a snapshot, so an entry made as a Manager stays hidden after a promotion.
  The filter is written as an `OR` that names `actorRole: null`, because
  SQL's `NOT` over a null role would hide every customer and system row
  from every manager.
- **A non-manager's audit read is one record by `ref`, which a module
  vouches for through `AuditRefAccess.register`; with no reader it is
  refused** (plan §4.8, §6.1). Only the record's module knows its row
  filters (a Bartender's Bar orders, a user's own tasks), so each C4+
  module registers a reader for its refs in `onModuleInit`. The registry
  fails closed: a module that forgets to register leaves its history
  unreadable to staff, never readable by everyone. Reception's one other
  query is `action=maintenance.save`; anything else is 403 with the role
  sentence.
- **An e2e suite that is not about sign-in mints its tokens with
  `accessTokenFor` and makes its accounts with `createStaffAccount`
  (`test/staff-fixtures.ts`).** Signing in through the route would put every
  suite under the sign-in throttle, and one fixture keeps the account's
  shape in one place.
- **An Owner-only settings key is refused to a Manager only when its value
  changes; sent unchanged it passes** (the demo's `settings.save`). The
  Settings screen sends the whole form, and a Manager saving the printer
  must not be refused for the VAT field beside it.
- **The six booking and ordering times and the opening hours are the
  Owner's, refused with `OWNER_ONLY_TIMES_MESSAGE`, until Q29 is
  answered** (its default: "the Owner only, like VAT and fees"). The demo
  had neither, so the sentence is new and follows the settings sentence's
  form; changing the rule is moving these keys, not rewording a refusal.
  When a save changes both kinds, the money keys are checked first, as the
  demo checks them.
- **A request body is validated before any Owner rule that depends on the
  stored record, so a non-Owner sending a malformed Owner-only value is told
  what is malformed (400), and the Owner sentence (403) follows once the
  value is well formed.** This is a deliberate change of order from the
  demo, whose `settings.save` and `staff.save` check the Owner first. The
  ValidationPipe runs before any service, the settings rule depends on the
  row's current values (an unchanged value passes), and running Owner rules
  on an unvalidated body in a guard would copy each rule outside the
  transaction that holds the row. Only a hand-made request sees the
  difference: the demo's screens do not offer a non-Owner the Owner-only
  fields. "The money keys are checked first" above holds for well-formed
  input; `test/staff-demo-ports.e2e-spec.ts` pins the order. Role checks
  (`@Roles`) are guards and still come first, as `requireRole` does.
- **A command whose demo checks an Owner rule before its role rule carries
  no `@Roles`; the service refuses every non-Owner with the Owner
  sentence** (from C4: `stock.adjust`). The demo's Correct Balance calls
  `ownerOnly` first, so a Waiter is told "Only the Owner can correct a
  stock balance.", not the role sentence; a `@Roles()` guard would answer
  the other sentence first. The rule is checked before the idempotent
  transaction opens, as `menu.save`'s new-item rule is.
- **Printing happens in the browser from data the API already serves; the
  server only records it, through `POST /staff/audit/print`** (from C4,
  `src/audit/print.service.ts`, plan §5.3 and A19). A receipt is the bill
  read (`GET /staff/orders/:id`: lines, totals, every payment) plus the
  business lines on `GET /staff/reference`; a docket is
  `GET /staff/dockets/:ref`. No print-shaped endpoint repeats them, so a
  printed figure can never disagree with the screen's. The record is the
  demo's audit-only `print` row: action `print`, the ref the screen sent,
  after `{document, revision}` and the period for an attendance print. Any
  staff role may print (the demo's `print` names every non-manager role),
  so the route has no `@Roles`. It takes no version and no Idempotency-Key
  because it changes nothing: a retried print is a second print, and the
  history should say so.
- **The print record accepts only the documents a screen can print**
  (`PRINT_DOCUMENTS`: docket, bill, receipt, purchase, staff, attendance,
  CSV export), with a ref of at most 120 characters. The demo stored any
  text, and a history row naming a document nobody can print would mislead
  its reader. Its four refusal sentences are new and marked so in
  `print-documents.ts`.

## Stock *(from C4)*

- **`StockLedgerService.move` (`src/stock/stock-ledger.service.ts`) is the
  one writer of `StockBalance` and `StockMovement`; every command that moves
  stock calls it inside its own transaction** (plan §4.6). It writes the
  balance and the movement that explains it together, so the balance is
  always the running sum of the movements (the e2e suite checks the sum),
  and a refusal anywhere rolls both back. `grep -rn "stockMovement.create\|stockBalance" src/`
  should find only the ledger and the reads.
- **A decrement is one conditional `UPDATE … WHERE qty + delta >= 0`, and
  its refusal is 409 with the demo's "Insufficient <location> stock for
  <item>."** No read comes first, so two commands taking the last pack
  cannot both pass (TAY's `StockService`); the e2e race test fails when the
  condition is removed. 409, because the input is well formed and the
  stock's state refuses it (A7).
- **There is no `qty >= 0` CHECK on `StockBalance`; `allowNegative` is for
  a paid web order's drinks only** (plan §7.4). The money is already taken
  when a web order's drinks are deducted, so stock never blocks it; every
  other movement is refused below zero in the ledger.
- **`StockMovement` is append-only by trigger, as the audit log and the
  approvals ledger are; a correction is a new movement.** A movement edited
  or deleted leaves a balance no history explains. Its foreign keys
  restrict, never set null, because that would be an UPDATE the trigger
  refuses.
- **A missing `StockBalance` row is a zero balance; rows are created on the
  first movement with an insert that skips duplicates.** The 87 seeded Bar
  items start with no rows (Q11), and an `ON CONFLICT DO NOTHING` insert
  lets two first movements of one item meet on the unique index instead of
  both inserting.
- **Which locations hold which items is `locationHolds`
  (`src/stock/stock-locations.ts`): every item at the Store, a Kitchen item
  in the Kitchen, a Bar item at the Bar** (D45: `kind`, not an id prefix).
  Commands check it first with their own sentence; the ledger refuses
  anything else as a programming error, so no movement can put a portion
  behind the bar.
- **A command that reads balances and then moves them by the difference (a
  stock count) locks them with `lockBalances`, in id order, for its whole
  transaction.** A sale landing between the read and the move would
  otherwise be counted over; the id order means two counts over the same
  items cannot deadlock each other.
- **A stock count follows Q28's default: its differences are valued by
  `stockValueAtKobo` (`src/stock/stock-value.ts`) and passed to
  `MoneyControlService.withinLimit` as `LIMITED_DECISIONS.stockCount`,
  counted toward the day** (the plan places the limit "if Q28 says so"; Q28
  is unanswered, and its stated default is "yes to both"). Above the Owner
  Approval Limit only the Owner may record the count, and the Storekeeper's
  counts enter the ledger like a manager's decisions. A count with no
  difference decides nothing and is never limited. The limit takes its
  advisory lock after the count has locked its balances; a waste approval
  (C5) takes them the other way round, so the two by one manager on one
  item at one moment can deadlock, which Postgres breaks by failing one.
- **Stock is valued as its location holds it, by one function,
  `stockValueAtKobo`, which a count and a write-off both call** (plan
  §4.6, §7.8; Q25 answered by the founder on 2026-10-22). The Kitchen and
  the Bar hold units, valued by `stockValueKobo` (the demo's `wasteValue`):
  a Bar item at menu price × quantity, a Kitchen item at the latest pack
  cost ÷ the pack's units × quantity, rounded to the kobo. The Store holds
  packs, valued per pack: a Kitchen item at packs × the latest pack cost
  exactly, a Bar item at packs × How Many in One × its menu price. Zero when
  no cost is known, as in the demo. One function, so a count and a
  write-off of the same stock can never be valued two ways; Q25's answer
  is that they must agree.
- **A direct issue and a Correct Balance take an `Idempotency-Key`; a count
  and a new stock item do not** (the *Idempotency* rule for creates). A
  retried issue or correction would move stock twice; a retried count finds
  no difference left to record, and a retried create is refused on the
  name.
- **No `AuditRefAccess` reader is registered for stock refs** (a stock
  item's id, a location, a dish's slug for a comparison rule). Plan §4.8
  lets a non-manager read the history of an order or docket, a request, a
  purchase, a waste entry, an online order or a task; stock items are not on
  the list, so the registry's fail-closed answer is the rule. Movements are
  read through `GET /staff/stock/movements` (managers and the Storekeeper).
- **A kitchen comparison rule (`KitchenMapping`) carries no `version`; its
  save locks the dish's `MenuItem` row (`FOR UPDATE`) and replaces the whole
  rule.** A8 does not list it, and a rule is replaced, not edited, so the
  last save wins; the lock stops two saves interleaving their portions. The
  rule never fills in a kitchen entry or moves stock.
- **A Store count's difference is valued per pack, through
  `stockValueAtKobo`; a Kitchen or Bar count's difference is in units**
  (from the C4 review, kept by Q25's answer). Valued as units, a Store
  count of nine batches of a ₦5,000 drink (108 servings) was ₦45,000 and
  slipped under the ₦50,000 Owner Approval Limit. Every caller valuing
  stock at a location goes through `stockValueAtKobo`, a write-off included
  (see *Waste*); calling `stockValueKobo` on Store packs is the bug the C4
  review found.
- **`stock.count` takes an `Idempotency-Key` after all; this replaces the
  count half of the rule above that a count needs none** (from the C4
  review). A count writes `counted − recorded` as read at retry time, so a
  retry after a lost response undid any sale or issue that landed between
  the two tries, and counted its value toward the manager's day again. The
  role rule is checked in the controller before the idempotency service, as
  Correct Balance's Owner rule is. A new stock item still needs no key: a
  retry is refused on the name.

## Stock requests, purchasing, waste, tasks, assets and attendance: the schema *(from C5)*

- **The C5 tables are one migration (`c5_core`), and its hand-written part
  holds each record to the shapes the staff app allows** (plan §4.6,
  §4.7): a request's status follows its packs (`StockRequest_status_check`),
  a rejection carries its reason, a purchase line's received packs are none
  or all of it (D39), a Fixed or Not Fixed repair has its resolved date
  (R3), a shift ends after it began. The services refuse each case first
  with the demo's sentence; the CHECK is the backstop for a write that does
  not come through a route, and `test/c5-schema.e2e-spec.ts` watches each
  one refuse.
- **One open shift per person is the partial unique index
  `AttendanceRecord_staffId_key` (`WHERE "timeOut" IS NULL`)**, named as the
  partial-index rule above says, so two scans racing for one person cannot
  both open a shift and the clash reads as `["staffId"]`. The scan's
  advisory lock (C5-7, TAY's pattern) decides the ordinary case; the index
  decides the race.
- **A task links only to the kind of record its type names: a CHECK holds
  `purchaseId` to Purchase tasks and `maintenanceId` to Maintenance tasks**
  (`Task_values_check`). `task.save` sets the links from the type, so a
  task whose link and type disagreed would be one no screen can make; a
  command that links a task to a repair (C5-6's `maintenance.save` with a
  task) must refuse, or give the Maintenance type to, any other task.
- **No C5 table is append-only by trigger.** The plan names three
  (`AuditLog`, `ApprovalLedger`, `StockMovement`); the history tables
  (`TaskHistory`, `MaintenanceHistory`, `AttendanceCorrection`) carry no
  `updatedAt` and are only ever added to by their services, by convention,
  as TAY keeps its histories. Making one append-only is a plan change.
- **A purchase line has a `position`, its place in the list the screen
  sent, and one line per item per purchase (unique on `purchaseId`,
  `stockItemId`).** A cuid or a timestamp is no order a requisition can be
  read back in, and the demo's duplicate rule ("Combine duplicate items
  into one quantity.") already allows one line per item.
- **`latestPackCostKobo` (`src/stock/stock-value.ts`) is the line for the
  item on the most recently raised purchase that is Approved or Fulfilled
  (`APPROVED_PURCHASE_STATUSES`, `src/purchasing/purchase-rules.ts`), never
  Pending, Rejected or Cancelled** (C5-1 filled in C4's null; Q25 answered
  by the founder on 2026-10-22: "pack cost comes only from Approved or
  received purchases"). A Pending requisition is a cost nobody has agreed:
  whoever raised it would set the value their own write-offs, the approvals
  prediction and the Q28 count limit are judged on, before any manager
  reviewed it (the C5 review). Receiving is all at once (D39), so
  "received" is Fulfilled; there is no partly received status. "Latest"
  stays the most recently raised costing purchase: the decision names which
  purchases count, not a new order. One query whose relation filter and
  order are joins, so it is safe inside a transaction.

## Stock requests *(from C5)*

- **Every request command is in `StockRequestsService`
  (`src/stock/stock-requests.service.ts`) and claims the request's `version`
  first; issue and reject then refuse a request that is no longer Pending
  or Partially Issued with 409 "This request is no longer open."** The
  claim is the row lock the rest runs under (*Optimistic concurrency*), so
  two Storekeepers issuing one request end as one issue and one stale 409;
  the e2e race test fails when the claim is removed.
- **A request's location is the demo's: the Kitchen for a Kitchen user, the
  Bar for a Bartender or a Cashier whatever they send, and the Kitchen or
  the Bar as a manager chooses** (`requestLocationFor`,
  `src/stock/stock-request-rules.ts`). The screen offers the first three
  roles no choice, so a sent location is ignored as the demo ignores it; a
  manager's missing or Store location is "Choose Kitchen or Bar.". The item
  must be one the location holds (`locationHolds`).
- **A request asks for whole packs, as the Store counts them; an issue
  moves −packs at the Store (`ISSUE_TO_KITCHEN`/`ISSUE_TO_BAR`) and +packs ×
  How Many in One at the request's location (`STOCK_RECEIVED`), both through
  `StockLedgerService.move` with the request number as the ref** (plan
  §7.6). The C5 gate's step 4 is two bags of rice: Store −2, Kitchen +100.
  The Store-side type comes from `ISSUE_TYPE` (`src/stock/stock-locations.ts`),
  the one map the direct issue uses too, so the same transfer is recorded
  under the same type whichever route made it.
- **An issue's packs are judged in the service, not the DTO
  (`issueProblem`), because the demo's sentence names the item's pack:
  "Enter a whole number of bags within the remaining request."** The DTO
  only admits the field (`@Allow()`); a figure that is not whole, not above
  zero, above what is left, or whose units would not fit an `Int` column
  answers that one sentence.
- **`request.issue` applies `MoneyControlService.notOwn` with
  `OWN_RECORD_KINDS.stockRequest`, by staff id; the Owner is exempt** (the
  demo's `notOwn(r.by, 'stock request')`, plan §6.2 "issue: N"). Only a
  manager can both raise and issue (the Storekeeper cannot raise), so this
  is the manager who asked for stock sending it to themselves.
- **`request.create` takes an Idempotency-Key; issue and reject do not**
  (the *Idempotency* rule for creates). A retried create would ask twice; a
  retried issue or reject names a version the first attempt moved and is
  refused as stale.
- **A rejection keeps its reason in `rejectReason`, apart from the note,
  and leaves packs already sent where they are.** The demo appended
  " | reason" to the note, which mixed the requester's words with the
  Store's; the response carries both fields.
- **The requests read (`GET /staff/stock/requests`) is the Stock & Requests
  roles: a Kitchen user the Kitchen's requests and a Bartender the Bar's
  (`scopedStockLocation`, shared with the balances read), the Storekeeper
  and managers both or the one asked for; a scoped role asking for the
  other location is the role refusal** (plan §6.1). The Cashier raises Bar
  requests from the till but has no Stock & Requests page, so it has no
  read and no request history. `openCount` is the screen's Open Requests
  figure over what the reader sees, whatever the status and search filters,
  as the orders list carries its `counts`.
- **`StockModule` registers the `AuditRefAccess` reader for `SR-` numbers:
  the Storekeeper for every request, a Kitchen user and a Bartender for
  their own location's** (`src/stock/stock-request-audit-reader.ts`, plan
  §4.8). The request must exist.
- **A request id that names nothing is 404 "Stock request not found."**
  (new: the demo answered it with "This request is no longer open."; the
  version claim needs one not-found sentence, in the form of "Stock item
  not found.").

## Purchasing and vendors *(from C5)*

- **Every purchase command is in `PurchasesService`
  (`src/purchasing/purchases.service.ts`) and, after the create, claims the
  purchase's `version` first; a purchase id that names nothing is 404
  "Purchase not found." (new), and a purchase in the wrong state is 409 with
  the command's own demo sentence** ("Only active pending requisitions can
  be reviewed.", "Receive only approved requisitions.", "Received or
  archived purchases cannot return to approval.", "Select an active
  purchase record.", "Purchase not found or already archived."). The demo
  answered a missing purchase with each command's state sentence; one
  not-found sentence is what the version claim needs, as C5-2 decided for
  requests. Two managers approving at once, or two receipts of one
  delivery, end as one success and one stale 409; both race tests fail
  with the claim removed.
- **An approval (`purchase.approve`, and `purchase.status` to Approved from
  any other status) runs `MoneyControlService.withinLimit` with
  `LIMITED_DECISIONS.purchase`, counted toward the day, then `notOwn` with
  `OWN_RECORD_KINDS.purchase`, in the demo's order; the purchase's total is
  packs × cost over its lines (`purchaseTotalKobo`)** (plan §6.2 "approve:
  L, D, N"). The limit sentence before the own-record one is the demo's
  order, so a manager approving their own ₦140,000 purchase is told about
  the limit. A rejection spends nothing: a manager may reject their own,
  and nothing is counted.
- **`purchase.edit` holds both the old and the new total to the Owner
  Approval Limit. On an approved purchase (Approved or Fulfilled,
  `isApprovedPurchase`) the increase of the total (`increaseKobo`) also
  counts toward the editor's Daily Approval Limit, and a manager may not
  correct a purchase they raised (`notOwnCorrection`, 403 "You cannot
  change an approved purchase you created. The Owner or another manager
  must change it."); the Owner is exempt from all of it** (the founder's
  decision of 2026-10-22, amending plan §6.2's "L on the old and new
  totals"). Raising an approved total is a fresh decision of the
  difference, counted as `order.discount` counts "the increase only";
  without it a manager could take an approved purchase past the day's
  limit, or raise their own once a colleague had approved it. A decrease
  adds nothing to the day, and a Pending requisition's correction counts
  nothing because its approval will. The checks run in the approval's
  order (limit, day, own record), and a refusal rolls back the ledger row
  and any Store correction with the command.
- **The automatic tasks are raised and closed only through
  `src/tasks/automatic-tasks.ts` (`raiseAutomaticTask`, `closeOpenTasks`,
  `managerForTask`, `storekeeperForTask`), in the command's transaction**
  (plan §7.7, §7.9). A task raised in a transaction of its own would
  survive a refused command, and two copies of "who gets it" would disagree.
  C5-6's repairs use the same helpers.
- **A review task goes to the first active Manager (else the first active
  Owner, else the actor); a receive task to the first active Storekeeper
  (else whoever gets a review); "first" is the order the accounts were
  made in** (the demo's `managerName` and `storeName`, which took the first
  in its staff list). By id (A10), never by name. A suite that asserts who
  got a task runs on its own database (`test/purchasing.e2e-spec.ts`), since
  on the shared one the first Manager is another suite's.
- **A purchase's automatic tasks follow its status (`taskForStatus`): when
  the status changes, its open automatic tasks close and the new status's
  task opens; Pending waits on a review, Approved on receiving, every other
  status on nobody** (plan §17, R1). The demo opened the receive task only
  from `purchase.approve`, so a manager approving by status correction left
  the Storekeeper with nothing to do; R1 corrects that, and the same rule
  gives a purchase returned to Pending its review again and closes the
  stale receive task. Only `automatic` tasks move with the status: a task a
  person linked to the purchase stays open until it is received or
  archived, as in the demo.
- **Receiving and archiving close every open task on the purchase,
  automatic or not** (the demo's `purchase.receive`; R1 for the archive).
  The work a task tracked is over either way.
- **`closeOpenTasks` moves each closed task's `version` in its one
  conditional update and writes an automatic `TaskHistory` row by the person
  whose command closed it.** A person saving the task from a screen read
  before the close is then refused as stale instead of reopening it unseen.
- **Receiving is all at once (D39): each line's remaining packs enter the
  Store as `PURCHASE_RECEIPT`, and a correction of a received purchase moves
  the Store by each item's new quantity less what was received
  (`correctionMoves`) as `PURCHASE_CORRECTION`, both through
  `StockLedgerService.move` under the purchase number.** The new lines of a
  received purchase count as received in full, so the Store holds exactly
  the corrected packs; a correction below what the Store still holds is
  refused by the ledger's "Insufficient store stock for <item>.".
- **`purchase.create` and `vendor.save` (a new vendor) take an
  Idempotency-Key; every other purchase and vendor command does not** (the
  *Idempotency* rule for creates): a retried create would raise a second
  requisition or add a vendor twice, and every other command names a
  version the first attempt moved.
- **A requisition line's vendor is its own `vendorId`, or on a new
  requisition the request's `vendorId`; the requisition's vendor is its
  first line's** (the demo's `l.vendorId||c.vendorId`; the schema's
  header rule). The demo set the header from the request first; the screen
  sends a vendor on every line, so the two agree on everything a screen
  sends, and the stored header is always a vendor a line names. An edit
  names a vendor on every line, as the demo's edit requires.
- **Line checks follow the demo's order per command: `purchase.create`
  checks each line's vendor and then its item and cost, `purchase.edit` the
  item and cost and then the vendor; the list's own sentences (empty,
  duplicates, quantities) come first, from `@ValidLines`.** The cost is
  checked in the service (`isLineCost`), beside the item, because the
  demo's one sentence names both ("Choose a stock item and positive unit
  cost."). The item id itself is left to the service too (`@ValidLines`
  with `idMessage: null`; a blank or non-text id reads as no item through
  `sentId`): the demo's `positiveLines` never checks the item, so the
  staff app's untouched new line, with neither vendor nor item, answers
  "Choose an active vendor for every line." on a create, as in the demo
  (C5 review; it used to answer the item sentence, refused in the DTO).
- **`vendor.save` replaces the whole profile, and changes `isActive` only
  when it is sent** (R2's rule for staff accounts, applied to vendors). The
  demo made a vendor Active again whenever the form left the status out; a
  phone fix must not quietly put a deactivated supplier back on every
  purchase form. A vendor's audit ref is its id: a vendor has no human
  number, and no non-manager reads a vendor's history, so no reader is
  registered.
- **Every screen names vendors from the lite list on `GET /staff/reference`
  (`vendors: [{ id, name, service, isActive }]`); phone, email and address
  are on `GET /staff/vendors` only (the Storekeeper and managers).** Reception
  picks a vendor for a repair (C5-6) and the purchase forms pick active
  ones; neither needs a supplier's contact details, which the Vendors page
  keeps to the roles plan §6.1 gives it.
- **`PurchasingModule` registers the `AuditRefAccess` reader for `PR-`
  numbers: the Storekeeper, for every purchase that exists**
  (`src/purchasing/purchase-audit-reader.ts`, plan §4.8). The Storekeeper's
  list shows every requisition, so their history access matches it.
- **The bell shows the reader's assigned tasks that are not Done ("Assigned
  Task · Open", the task's title, page `tasks`), after every other item, to
  a role whose pages include Tasks** (the demo's `staffNotifications`; the C5
  gate's step 2). The page rule keeps every bell item openable. The demo
  hides a manager's own review tasks while the approvals alert is on,
  because the Purchase Approval item stands in for them. *From C8-2 the
  Purchase Approval item exists and the rule is applied (see* The staff
  bell*); a review task shows only while the approvals alert is off.*

## Waste *(from C5)*

- **Every waste command is in `WasteService` (`src/waste/waste.service.ts`)
  and, after the create, claims the entry's `version` first; an id that
  names nothing is 404 "Waste record not found." (the demo's `waste.edit`
  sentence, used by every command), and approving or rejecting an entry
  that is not Pending is 409 "Only pending waste can be reviewed."** The
  claim is the row lock the rest runs under, so two managers approving one
  entry end as one approval and one stale 409, and the stock leaves once.
- **Each role logs and reads waste at its own location: the Kitchen the
  Kitchen's, a Bartender or a Cashier (from the till) the Bar's, the
  Storekeeper the Store's; managers any location** (`wasteLocationFor`,
  `src/waste/waste-rules.ts`; plan §6.1, the demo's `WasteRecords`). Logging
  elsewhere is 403 with the role's own demo sentence ("Kitchen staff can log
  kitchen waste only."), because it is a refusal by role, not bad input; a
  scoped role reading another location is the role sentence, as on the
  requests read. The item must be one the location holds (`locationHolds`).
- **`waste.create` checks in the demo's order (location, the role's own
  location, quantity and reason, item), so the item, quantity and reason
  are `@Allow()` in the DTO and judged in the service.** The demo's sentences
  each cover two fields ("Enter a whole quantity and a waste reason.",
  "Choose an item for this stock location."); checked in the DTO, a request
  wrong in both would answer the sentence twice (*Errors*). `waste.edit`
  does the same with its own words, after its reason (`@AdminReason`).
- **Stock moves only when an entry is approved, and only through
  `StockLedgerService.move` under the waste number** (plan §7.8): an
  approval takes the quantity (`WASTE`), a status change away from Approved
  returns it (`WASTE_APPROVAL_CORRECTION`), and a correction of an approved
  entry returns the old quantity at the old location and takes the new one
  at the new location (`WASTE_CORRECTION_RETURN`,
  `WASTE_CORRECTION_DEDUCTION`), as the demo moves them. A location that
  cannot cover the approval refuses it with the ledger's "Insufficient …
  stock for …." and the approval, its ledger row included, rolls back.
- **The value is Q25's, as the founder answered it on 2026-10-22:
  `stockValueAtKobo` on the entry's quantity as its location holds it, so
  Store waste is valued per pack (one bag of rice at ₦70,000 is ₦70,000),
  Kitchen waste at the pack cost ÷ How Many in One × units, and Bar waste
  at menu price × quantity; the pack cost comes only from Approved or
  Fulfilled purchases (`latestPackCostKobo`)** (plan §4.6, §7.8; card
  C5-4). Valued as units, as the coded formula did, one bag was ₦1,400,
  which kept most Store write-offs under a Manager's ₦50,000 limit, and a
  Store count of the same bag was valued at ₦70,000: the founder's answer
  is that the two agree and the Owner approves a write-off worth more than
  the limit. The count and the write-off share the one function, so they
  cannot drift apart again. Entries stored before the answer keep the
  value they were logged at until they are corrected or approved.
- **The value is stored on the row when the entry is logged and corrected,
  and valued afresh when it is approved (by `waste.approve` or by
  `waste.status` to Approved), which stores the new value** (plan §4.6
  stores it at creation and on edit; the demo values the decision as it is
  made). A purchase recorded between the logging and the approval would
  otherwise let a write-off be approved at a stale, smaller value, and the
  row then holds the value the decision was judged on.
- **A value `WasteEntry.valueKobo` (an `Int`) cannot hold is refused
  before it is written (`fitsValueColumn`): on `waste.create` and
  `waste.edit` with the command's quantity sentence, 400; on an approval
  with "This write-off is worth more than can be recorded. Correct its
  quantity first." (new), 409, before the limits** (C5 review). The
  quantity is capped at `INT4_MAX`, but a capped quantity times a menu
  price is not (a typed 10000 for 10 of a ₦2,500 drink), and Postgres
  would answer 500 (*Data and migrations*). The approval's check comes
  before the limits because the Owner is exempt from them; it is a 409
  because the request is sound and the entry's state is what blocks it (a
  price raised after the entry was logged is the only way there).
- **The two money-control points the C5 review left for the founder are
  decided (2026-10-22) and built** (recorded so the history of the rule is
  in one place):
  - *The pack cost came from any requisition not Rejected or Cancelled,
    Pending included*, so whoever raised one set the cost their write-offs
    and counts were judged on. Decided: only Approved or Fulfilled
    purchases set it (see the C5 schema section).
  - *A correction of an approved record was held to the Owner Approval
    Limit only* (plan §6.2 "edit: L"), so a manager could raise an
    approved value past the Daily Approval Limit, or raise their own record
    after a colleague approved it. Decided: the increase counts toward the
    day and the own-record rule applies (the `waste.edit` rule below, and
    `purchase.edit` under *Purchasing and vendors*). This amends plan
    §6.2's `waste.edit` and `purchase.edit` rows.
- **An approval (`waste.approve`, and `waste.status` to Approved from any
  other status) runs `MoneyControlService.withinLimit` with
  `LIMITED_DECISIONS.writeOff`, counted toward the day, then `notOwn` with
  `OWN_RECORD_KINDS.wasteEntry`, in the demo's order** (plan §6.2
  "approve: L, D, N"). The C5 gate's steps 5 and 6 are the
  own-record refusal and the fourth ₦40,000 approval refused at ₦160,000.
  A rejection writes nothing off: a manager may reject their own entry, and
  nothing is counted. The approval takes the limit's advisory lock before
  the ledger's balance row; a stock count takes them the other way round
  (see *Stock*).
- **`waste.edit` holds the new value to the Owner Approval Limit; on an
  Approved entry the increase over the stored value (`increaseKobo`) also
  counts toward the editor's Daily Approval Limit, and a manager may not
  correct an entry they logged, up or down (`notOwnCorrection`, 403 "You
  cannot change an approved waste entry you created. The Owner or another
  manager must change it."); the Owner is exempt from all of it** (the
  founder's decision of 2026-10-22, amending plan §6.2's "edit: L"; new
  sentence, in the own-record sentence's form, because the demo had none).
  Raising an approved write-off is a fresh decision of the difference,
  counted as `order.discount` counts "the increase only", so the day's
  limit cannot be walked round by approving small and correcting upward.
  The old value is the stored one, the value the approval or the last
  correction was judged on. A decrease adds nothing; a Pending entry's
  correction counts nothing, because its approval will. The checks run in
  the approval's order (limit, day, own record) before any stock moves, so
  a refusal moves nothing and leaves no ledger row; two increases by one
  manager racing past the limit are serialised by the ledger's advisory
  lock and the second is refused (`test/waste.e2e-spec.ts`,
  `test/purchasing.e2e-spec.ts`).
- **`waste.create` takes an Idempotency-Key; every other waste command does
  not** (the *Idempotency* rule for creates): a retried create would log the
  loss twice, and every other command names a version the first attempt
  moved.
- **The read (`GET /staff/waste`) answers `pendingCount`, the entries
  awaiting review at the locations the reader sees, beside the page**, as
  the requests read carries `openCount`; the views are the screen's
  Pending, History and All. Each entry carries `measure`, the item's pack at
  the Store and its unit elsewhere, so a screen never has to work out what
  "2" counts.
- **`WasteModule` registers the `AuditRefAccess` reader for `W-` numbers:
  each logging role for its own location's entries**
  (`src/waste/waste-audit-reader.ts`, plan §4.8), matching the read. The
  Cashier logs Bar waste from the till and sees the Bar's recent entries
  there, so it reads their history too.

## Approvals *(from C5)*

- **`GET /staff/approvals` is a read only; the decisions stay on the
  purchase and waste routes** (plan §5.4: "purchase and waste approve or
  reject (above)"). One command per decision keeps one place where the
  limits, the own-record rule, the version and the ledger are applied; a
  second approve route on this screen would be a second copy of them to
  keep in step.
- **Managers only (`@Roles()`), every location, and no `AuditRefAccess`
  reader** (plan §6.1: Approvals is a managers' page). Managers already
  read every record's history, so a reader would grant nothing.
- **The list answers are `PurchasesService.approvalsPage` and
  `WasteService.approvalsPage`, built on each service's own answers and
  search** (`purchaseSearch`, `wasteSearch`), so a requisition or an entry
  reads the same on the Approvals screen as on its own screen. Pending is
  oldest first (a queue, in the order it was raised); History is newest
  first. Pending requisitions are Pending and not archived
  (`AWAITING_APPROVAL`, also the Purchasing screen's Awaiting Approval).
  The page and page size apply to each list on its own, because the screen
  shows them in two tables.
- **Each Pending record carries `awaiting`: `awaits` (OWNER above the Owner
  Approval Limit, otherwise MANAGER), the value it would be judged on, and
  whether the reader's approval would pass now, with the exact sentence it
  would be refused with** (the card's "what awaits whom"). The screen can
  then say why Approve will fail before the manager presses it, in the
  command's own words (A7).
- **The prediction is `approvalRefusal` in `MoneyControlService`, a pure
  function of `standing()` (the limits and the reader's ledger total for
  the Lagos business date), in `withinLimit`'s then `notOwn`'s order.**
  It is beside the rules it predicts so the two cannot drift; a unit test
  runs the prediction and the command side by side, decision after
  decision. `standing()` takes no lock, because a read decides nothing:
  the command decides again under the ledger lock, so a prediction can be
  one decision behind a race, never a permission.
- **Each pending record is judged on its own against the reader's total so
  far today**, not cumulatively down the list. Approving one changes what
  the next is judged on, which the screen sees on its next read; a
  cumulative forecast would assume an order of approvals the manager has
  not chosen.
- **A pending waste entry is valued afresh for `awaiting.valueKobo`
  (`WasteService.decisionValueKobo`, the function its approval uses), while
  the entry's `valueKobo` stays the stored one.** The approval revalues the
  entry (see *Waste*), so the prediction must too, or a purchase recorded
  since the entry was logged would make the screen predict on a stale value.
- **New sentence: "Choose Pending or History." for an unknown view (400).**
  The demo filtered on the client and refused nothing.
- **The demo's "manager bell contains pending approvals and removes each
  when it is resolved" is ported onto this read
  (`test/approvals.e2e-spec.ts`); the bell item itself is C8-2's**
  (plan §9.1), and the C5 gate does not need it. *Built in C8-2:* see
  *The staff bell*.

## Tasks *(from C5)*

- **`task.save` is two routes, `POST /staff/tasks` and
  `PATCH /staff/tasks/:id`, in `TasksService` (`src/tasks/tasks.service.ts`);
  the update claims the task's `version` first, and an id that names
  nothing is 404 "Task not found." (new)** (plan §5.4). The demo saved an
  unknown id as a new task; on the server an update names a task, and the
  version claim needs a not-found sentence.
- **Only Reception, the Cashier, the Kitchen, the Storekeeper and managers
  may read or save a task (`@Roles`, D42's role gate); a Waiter or
  Bartender is refused with the role sentence and is never an assignee**
  (plan §4.7, §6.2). The demo had no role check on `task.save`, so a Waiter
  updating a task was refused only because it was not theirs; the role gate
  is the plan's correction.
- **Anyone but a manager raises a task to a manager (the Owner included) or
  to themselves, and on a task that exists may change only its status, and
  only when it is assigned to them; each refusal is 403 with the demo's
  sentence** ("Raise a task to a manager, or to yourself.", "Only the
  assigned staff member or a manager can update this task.", "Only a
  manager can change task details.", "Only a manager can reassign tasks.",
  "Only a manager can change task links or type."), checked in the demo's
  order by `nonManagerSaveProblem` (`src/tasks/task-rules.ts`). The demo
  checks some of these before the description; here the DTO's one-sentence
  checks run first (*Money controls and the audit log*: a body is validated
  before the rules on the stored record).
- **A task's links follow its type (`linksFor`): a Purchase task links an
  open requisition (not Fulfilled, Rejected, Cancelled or archived:
  `isClosedPurchase`), a Maintenance task an open repair (not Fixed or Not
  Fixed), a General task nothing; a link of the other kind is dropped, as
  the demo drops it, and the record a task already links passes a manager's
  save even once closed.** This keeps every saved task inside
  `Task_values_check`, and a manager fixing the title of a task whose
  purchase was received is not refused for its history.
- **An assignee is an active member of staff who is neither a Waiter nor a
  Bartender, by id (A10); anything else is 400 with the demo's sentence**
  ("Choose an active staff member. Waiters and bartenders report…").
- **Every save adds a `TaskHistory` row (the status, who, not automatic),
  the status unchanged included, and an audit row `task.save` under the
  task number, in the same transaction**, as the demo appends to its
  history on every save. The tasks the commands raise and close themselves
  stay in `src/tasks/automatic-tasks.ts`, whose rows are marked
  `automatic`.
- **The tasks read shows managers every task and anyone else the tasks
  assigned to them and the ones they raised themselves; a task a command
  raised by itself is not one its actor raised** (`visibleTasks`; plan
  §6.1). The demo files an automatic task under "<name> (automatic)", so the
  Storekeeper does not see the review of a purchase they asked for; the
  server stores who raised it (`raisedById`) and excludes it by `automatic`.
  The read is ordered Open, In Progress, Done (Postgres orders an enum by
  its declared order), newest first within each, as the screen orders it,
  and carries each task's history and the reader's `counts` by status.
- **`POST /staff/tasks` takes an Idempotency-Key; the update does not** (the
  *Idempotency* rule for creates).
- **`TasksModule` registers the `AuditRefAccess` reader for `T-` numbers: a
  role that opens Tasks, for the tasks its read shows it** (`seesTask`,
  `src/tasks/task-audit-reader.ts`, plan §4.8).

## Assets and repairs *(from C5)*

- **Repairs are reactive only (Q13's default): a repair is logged when
  something breaks, and nothing is scheduled.** Q13 keeps assets and
  repairs with "no preventive schedule"; a schedule is a plan change.
- **`asset.save` is `PUT /staff/assets/:tag` (managers): with no `version`
  it adds the asset under the tag, and a tag already held is 409 "This
  asset tag already exists." (new); with a `version` it replaces the asset
  the tag names, claimed at that version, and an unknown tag is 404 "Asset
  not found." (new)** (`AssetsService`, `src/assets/assets.service.ts`).
  The demo replaced whatever asset held the tag; a create names no version,
  so it must not overwrite a record nobody read, and a retried create is
  refused on the tag as a new stock item is on its name (the *Idempotency*
  rule for creates), so the route takes no key. The tag is the path and
  never changes.
- **An asset's status changes on `asset.save` only when one is sent** (R2's
  rule, as for staff and vendors). The demo set an asset Active whenever
  the form left the status out, which would quietly undo the Under Repair
  a repair had just set.
- **The tag, name and quantity are judged together in the service, with
  the demo's one sentence "Enter a tag, name and quantity."**
  (`assetFieldsProblem`, `src/assets/maintenance-rules.ts`); the request
  admits them with `@Allow()` (*Errors*: one sentence per field).
- **`maintenance.save` is `POST /staff/maintenance` (with an
  Idempotency-Key) and `PATCH /staff/maintenance/:id` (versioned), for
  Reception and managers, in `MaintenanceService`; it checks in the demo's
  order (asset and vendor, description and cost, status, then the task) and
  every field is judged in the service** (plan §5.4, §6.2). The demo's
  sentences each cover two fields. A retried create would log the repair
  and its follow-up twice; the update names a version.
- **The asset follows its repair: Under Repair while Pending or In
  Progress, Active once Fixed, Inactive when Not Fixed
  (`assetStatusForRepair`), written by one conditional update that moves
  the asset's `version` only when the status changes.** It is the demo's
  rule; a manager's open asset form is made stale only by a real change,
  and the comparison is on the row as it stands, so two repairs on one
  asset cannot leave it on a status read before the other's save.
- **A repair moved to another asset releases the one it left: if that
  asset stands Under Repair, it follows its remaining repairs (Under
  Repair while one is open, else as its newest left it, else Active;
  `assetStatusAfterRepairs`), in the same transaction** (C5 review). The
  demo set only the named asset, so a repair logged on the wrong asset and
  corrected left that asset Under Repair with no open repair until a
  manager noticed. Active or Inactive are left alone: either may be a
  manager's own choice on `asset.save`, while Under Repair with nothing
  open is only ever a moved repair's leftover.
- **The resolved date is set once, to the Lagos date of the first move to
  Fixed or Not Fixed, and kept after, a reopened repair included; the
  reported date is the date the repair was logged** (plan §17, R3,
  `resolvedOnFor`). The demo reset it to today on every save of a closed
  repair, so recosting a repair a week later moved the day it was fixed.
  `MaintenanceRecord_values_check` holds every row to it.
- **A new repair raises "Follow up repair MT-…: <asset>" for a manager
  (`managerForTask`), unless it is logged for an existing task (`taskId`);
  Fixed or Not Fixed closes every open task on the repair
  (`closeOpenTasks`). All of it runs through `src/tasks/automatic-tasks.ts`
  in the command's transaction** (plan §7.9, "repairs open and close their
  own follow-up task"). A task raised or closed outside the transaction
  would outlive a refused save.
- **A repair logged for a task links it with one conditional update: the
  task must have no repair yet, becomes a Maintenance task, moves to In
  Progress and its `version` moves, with an automatic history row; an
  unknown task is 404 "Task not found.", a task with a repair 409 "This
  task already has a maintenance record.", and a Purchase task 400 "Choose
  a maintenance or general task." (new)** (R3 for the 404). The schema's
  `Task_values_check` lets only a Maintenance task link a repair, and a
  Purchase task already tracks a requisition, so it cannot be given the
  type. The condition decides two repairs racing for one task. The task
  the repair already links, sent again on an update, links nothing and
  passes, so a screen sending the whole record back is not refused.
- **A repair id that names nothing is 404 "Maintenance record not
  found." (new)**, the not-found sentence the version claim needs.
- **`AssetsModule` registers the `AuditRefAccess` reader for `MT-`
  numbers: a role that opens Assets & Maintenance (Reception), for any
  repair that exists** (`src/assets/maintenance-audit-reader.ts`, plan
  §4.8, §6.1 "repairs, history"). Assets get no reader: §6.1 gives
  Reception the assets to read, not their history.
- **`GET /staff/reference` carries `assets: [{ id, tag, name, location,
  status }]` only for the roles that open Assets & Maintenance (Reception
  and managers), and an empty list for everyone else** (plan §5.3, "assets
  (lite, for Reception and managers)"). The key is always there, so one
  client shape serves every role.

## Attendance *(from C5)*

- **Attendance is timestamps only, and its export is titled "Attendance
  review"** (Q12's default: "keep them (timestamps only…) and rename the
  export"). Nothing calculates lateness, absence or pay; the title lives
  once, in `ATTENDANCE_EXPORT_TITLE`.
- **`attendance.scan` (`POST /staff/attendance/scan`, Reception and
  managers) takes the decoded staff ID, `CNC-ID:<staff number>:<token>`,
  finds the account by its staff number and compares the token in constant
  time over SHA-256 digests (`tokensMatch`); the token is then dropped and
  is never in a response, a log, an audit row or a query** (plan §11, the
  staff card rule in *Auth*). A query by token would put the credential in
  any database error the service logs, and a plain `===` leaks by timing
  how much of a guess was right. The response is `no-store`.
- **A code that is not a staff ID, names nobody, carries the wrong token or
  belongs to a deactivated account is the demo's one 400, "This staff QR
  code is invalid or the account is inactive."** One sentence for all four,
  so a scanner tells a stranger nothing about which part was wrong.
- **The scan follows the demo: a scan within a minute of the person's last
  arrival or departure is a repeat and records nothing, audit included;
  otherwise the open shift closes, however long ago it began (an overnight
  shift closes on the next scan), and with none open a new one starts,
  dated by the Lagos day of arrival** (`scanStep`, plan §7.9). TAY's
  sixteen-hour cap and its "which shift?" question are not copied: CNC's
  demo and plan close on the next scan. The scan takes no Idempotency-Key:
  a retry within the minute is the ignored repeat.
- **Every scan and every correction of a person runs under that person's
  advisory lock (`pg_advisory_xact_lock` on `cnc:attendance:<staff id>`),
  taken before any row; the partial unique index
  `AttendanceRecord_staffId_key` is the backstop** (plan §4.7, TAY's
  pattern). Without the lock three scans of one card at once each closed
  the same shift (the race test fails so); one lock order for both
  commands means a scan and a correction cannot deadlock.
- **A departure scan moves the shift's `version`**, so a correction opened
  before it is refused as stale rather than undoing the departure unseen.
- **`attendance.correct` (`PATCH /staff/attendance/:id`, managers, with
  `@AdminReason`) takes Lagos wall clocks, `YYYY-MM-DDTHH:mm`, as the form's
  `datetime-local` fields hold them, and checks in the demo's order:
  "Enter valid attendance times.", "Attendance cannot be in the future.",
  "Check-out must follow check-in.", then 409 "This correction overlaps
  another shift."** A11 has the client send a date and a time and the
  server build the instant; the demo built `+01:00` instants in the
  browser. An empty or absent time out leaves the shift open.
- **A correction keeps the times it replaced as an `AttendanceCorrection`
  (who, when, why), returned with the shift, and moves the business date
  with the new arrival** (plan §4.7, §7.9 "corrections keep the previous
  times"). The History modal reads them from the record, not from audit
  before and after (A13).
- **The reads: `GET /staff/attendance/people` (the managers' directory of
  active staff), `GET /staff/attendance/:staffId` (managers) and
  `GET /staff/me/attendance` (everyone, their own) answer a month (this
  Lagos month by default) or a `from`/`to` range of arrival dates, oldest
  first, with the demo's summary, a page of a hundred by default; a range
  is at most 366 days ("Choose a period of 366 days or fewer.", new)** (plan
  §5.3, §5.4). A month is read in one page, as the screen shows it whole;
  a server read needs a ceiling the browser's did not. The filters are
  `ALL`, `COMPLETED` and `OPEN` ("Choose All Shifts, Completed or Open
  Shifts.", new).
- **The export is its own read, `GET /staff/attendance/:staffId/export
  ?from&to` (managers): the title, subtitle, file name, the staff app's
  columns and one row of text per shift in Lagos time (`formatWatShortStamp`,
  the app's `timeLabel`)** (A20: the staff app builds the CSV and PDF from
  rows with its own formula guard). The plan's "`?from&to` for export" is
  met by a sub-route so the export's shape and title are not mixed into
  the screen's read; one server definition of the rows keeps CSV, PDF and
  print preview in step.
- **No `AuditRefAccess` reader is registered for attendance**: plan §4.8
  gives no non-manager an attendance history, so the registry's fail-closed
  answer is the rule. A scan's audit ref is the person's staff number.

## Orders and dockets *(from C4)*

- **Every order command takes its bill through `OrdersService.claimOrder`
  (`src/orders/orders.service.ts`): the order must exist (404 "Order not
  found."), a Bartender reaches Bar bills only (403 "Bartenders can operate
  Bar POS only."), and then the request's `version` is claimed.** That is
  the demo's `order()` in its own order, and the claim is the row lock the
  rest of the command runs under (*Optimistic concurrency*). The
  department is read before the claim because it never changes; a
  Bartender is told the Bar sentence, not a stale-version one, for a bill
  that was never theirs. C4-5's payment and correction commands use the
  same method, so the rule is written once.
- **Lines, details and confirm name the order's `version`; only
  `order.create` takes an `Idempotency-Key`** (A9). A retried create would
  open a second bill; a retried line, detail or confirm names a version the
  first attempt already moved, so it is refused with the stale sentence
  instead of being applied twice. A reprint claims the version too and so
  moves it: one rule for every order command, and the reprint answers the
  bill with its new version.
- **A line is a dish plus its option; `option` is `""` for a dish with no
  choice, a dish with a choice needs one of its options, and each option is
  its own line** (`lineProblem`, `src/orders/order-rules.ts`). A line may
  always be set to zero, even for a dish taken off sale, so it can be taken
  off a bill. A new line snapshots the dish's name and price; an existing
  line keeps its price when its quantity changes (plan §4.1: a price change
  applies to new lines only).
- **Lines and details change only on an open bill of today
  (`assertEditable`, the demo's `allowOrder`): an earlier day's bill is 409
  "This order belongs to a previous day…", any other is 409 "This order is
  locked…".** Food added on a previous day is locked (plan §7.1 step 7);
  409, because the request is well formed and the bill's state refuses it
  (A7). Confirm is not held to the date: a carried bill confirms its frozen
  items after midnight, and its docket keeps the bill's business date.
- **`order.details` changes only the fields it is sent; `null` is
  refused.** The demo blanked a field left out of the command. The screen
  sends both, so nothing it does changes, while a client that sends only
  the notes no longer wipes the guest's name (the same reasoning as
  `staff.save`, R2).
- **Every docket row is written by `DocketsService.write`
  (`src/orders/dockets.service.ts`), and a revision is never changed after
  it is written.** The confirmed lines are the latest docket's items (there
  is no `confirmed` column), so the payment check (C4-5), the cancellation
  docket (C4-5), the web docket (C7) and the crosscheck (C4-6) all read the
  one snapshot shape (`docket-items.ts`). A revision changed in place would
  let the kitchen's paper and the record disagree.
- **A confirm whose lines equal the latest docket writes no revision and
  answers that docket with `reprint: true`; otherwise it writes revision
  n+1 with the full list.** The comparison (`sameDocketItems`) covers every
  snapshot field (dish, option, quantity, name, price) and ignores the order
  lines were added in, which in the demo was an accident of its array.
  Notes alone do not make a new revision, as in the demo.
- **A bill's figures are `orderTotals` (`src/orders/order-totals.ts`), the
  demo's `totals()` figure for figure, and nothing else computes them.**
  The list, the detail, the receipt and settlement's exact cover (C4-5)
  must agree to the kobo; one pure function is the only way they cannot
  drift.
- **The till's Part Paid filter is "a non-reversed payment above zero".**
  The demo's `paidSoFar > 0` is a sum, which a where clause cannot page
  over; on a till bill the only payments before settlement are part
  payments, so the two agree. A refund (negative) is a web order's (C7).
- **An order command's audit `ref` is the order number, and a docket's is
  its `KOT-` ref; lines are audited as `{ items: [...] }`.** The demo's
  `ref` for every `order.*` command is the order, so the bill's history
  shows its confirms; the kitchen's entries (C4-6) are filed under the
  docket. Wrapping the lines in an object gives the history the demo's
  "Order items updated (n lines)." rather than "Changed from 1 entry to 2
  entries.".
- **`OrdersModule` registers the `AuditRefAccess` readers for bill numbers
  (`CNCR-`, `CNCB-`: Cashier, Waiter, and a Bartender for Bar bills) and
  docket refs (`KOT-`: Kitchen, Cashier, Waiter), and both require the
  record to exist** (`src/orders/order-audit-readers.ts`). Those are the
  roles plan §6.1 lets open the till and the kitchen; a ref nobody issued
  has no history to read, so it gets the registry's refusal.
- **An optional text field in a request is `OptionalText`
  (`src/common/optional-text.ts`)**, moved out of the stock requests when
  the orders needed it: absent, or trimmed text up to a length, one
  sentence per problem, `null` refused.

## Payments, settlement and bill corrections *(from C4)*

- **Every money and correction command on a bill (`order.payment`,
  `partPay`, `settle`, `discount`, `cancel`, `reopen`, `reverse`) is in
  `OrderPaymentsService` (`src/orders/order-payments.service.ts`) and takes
  its bill through `OrdersService.claimOrder` first.** One claim per
  command is what makes two settles of one bill end as one settlement and
  one 409 "This record changed. Refresh and try again." (the A8 acceptance
  case): the second names a version the first moved. The e2e race test
  fails when the claim is removed.
- **Part payment and settle take both an `Idempotency-Key` and the bill's
  `version`** (A8, A9). The key makes a till's own retry of a lost response
  replay the first answer instead of taking the money again; the version
  makes a second till's settle of the same bill a stale 409. Neither covers
  the other's case.
- **The routes live in `OrderPaymentsController`, beside
  `OrdersController`, with a `@Roles` on each route and none on the
  reversal.** The demo's `order.reverse` calls `ownerOnly` first, so every
  non-Owner, a Waiter included, is told "Only the Owner can reverse a paid
  bill."; a class-level `@Roles` would answer the role sentence first (the
  `stock.adjust` rule in *Money controls*).
- **A payment list is checked as a list in the request (`payments` must be
  a list of objects, else "Payment information is missing.") and judged in
  the service by `judgePayments` (`src/orders/payment-rules.ts`), in the
  demo's order: the sum first, then each payment.** No nested validator
  can compare a sum with the bill's balance, and the order is visible: a
  transfer for the wrong amount is told about the amount, not its missing
  sender. The till's methods are Cash, Card and Transfer; `ONLINE` is
  Paystack's alone (C7) and is refused at the till.
- **A settlement's payments equal the balance to the kobo: the bill's
  `orderTotals` total less non-reversed payments and any deposit credit.**
  The receipt, the list and the settle must agree (*Orders and dockets*,
  `orderTotals`); a settle may carry no payment only when nothing is left
  to pay, a bill discounted to zero.
- **Each payment draws its own `PAY-` number from the sequence and is
  dated today in Lagos, not with the bill's business date.** The cash count
  (C4-8) compares a day's cash payments with the drawer, so a carried bill
  settled after midnight belongs to the day the money was taken.
- **A Bar bill's drinks leave the Bar at `order.settle` and return at
  `order.reverse`, through `StockLedgerService.move` in the same
  transaction, one movement per paired stock item in id order** (plan
  §7.2). The settle's state check and version claim make the deduction
  happen once per settlement; the reversal's "Select a settled POS order."
  makes the return happen once. Movements in id order cannot deadlock two
  settles sharing drinks, and a drink on two lines moves once by their sum,
  which the ledger allows or refuses exactly as the demo's line-by-line
  moves would. A drink with no paired stock item refuses the settlement
  (404 "Stock item not found."). The e2e suite proves both state checks by
  removal.
- **A reversal marks every payment reversed (with `reversedAt`) and never
  deletes one; settling again takes fresh payments.** Money that was taken
  and given back is history the cash count and the reports must still
  show.
- **A discount is checked by `MoneyControlService.withinLimit` as
  `LIMITED_DECISIONS.discount` on its whole amount, and only its increase
  over the bill's previous discount counts toward the day** (the demo's
  `withinLimit(c.amount, 'This discount', true, max(0, amount − old))`).
  Lowering a discount decides nothing and writes no ledger row; the Owner
  is never recorded.
- **Deposit credit at settle is the demo's logic, kept for its tests (D38):
  the booking must be checked in or completed at the bill's table, and the
  use is one conditional `UPDATE … WHERE "depositKobo" - "depositUsedKobo"
  >= $credit`.** Two bills spending the same credit cannot both pass a
  read-then-write. The update does not move the booking's `version`: the
  credit is the till's counter, not a field Reception edits, so a settle
  must not make Reception's next save of the booking stale. A reversal
  gives the credit back.
- **A cancelled Restaurant bill the kitchen was sent gets a cancellation
  docket (revision n+1, no items) through `DocketsService.write`; a Bar
  bill or a bill never confirmed gets none, and no stock moves.** The
  kitchen's own entries stay its own to correct (C4-6); the empty revision
  is what tells the kitchen's paper the bill is gone.
- **The bill's audit rows carry the demo's `before`/`after`: status for
  payment, reopen and cancel, `paidKobo`/`balanceKobo` for a part payment,
  `discountKobo` for a discount, and status, money and deposit for settle
  and reverse; the correction's reason goes in the row's `reason`.** The
  history then reads "Status changed from Open to Payment." in the staff
  app's words, and no payment detail beyond money reaches the log.
- **A bill never owes less than the money already taken against it: a line
  change, a discount and Proceed to Payment each call
  `OrdersService.assertCoversPaid`, which refuses with 409 "This bill
  cannot total less than the part payments already taken."** (from the C4
  review; a new sentence, the demo had none). The demo let a manager reopen
  a part-paid bill and cut it below its part payments; after that settle
  needs exact cover of a negative balance, cancel refuses a part-paid bill
  and reverse needs a settled one, so the bill and its table were stuck for
  good. Refusing the cut changes no price or payment rule; a bill brought
  down to exactly what was paid settles with no payment. Giving money back
  on a reopened bill (a refund or change path) is a money rule for the
  founder, not taken here.
- **A Bar settle that is short names the first short drink in bill order,
  as the demo's line-by-line moves do** (from the C4 review). The moves
  still go in stock-item id order so two settles cannot deadlock; before
  them the sale locks the drinks' Bar balances with `lockBalances` (also id
  order) and walks the lines in bill order to find the shortfall, so the
  sentence names the drink the screen expects. The ledger's conditional
  decrement still guards every move.
- **A settlement test that claims food stock does not move gives the dish a
  comparison rule and a kitchen entry first, and compares every movement of
  the portion and of the bill's and docket's refs before and after** (from
  the C4 review). Filtering by the bill's number alone, on a dish with no
  rule, passed with settle deducting by the rule or repeating the entry
  under `KOT-`; the stronger test was seen failing with such a deduction
  added.

## Kitchen entries, the kitchen day and the cash count *(from C4)*

- **A kitchen entry takes its order, revision and date from the latest
  docket under the ref the kitchen typed (`DocketsService.latestByRef`),
  never from the screen; a non-manager who sends one that differs is told
  it is "assigned by the system"** (`src/kitchen/kitchen.service.ts`, the
  demo's `kitchen.save`). The paper docket's number is the only thing the
  kitchen knows for certain, and an entry filed under the wrong revision or
  order would make the crosscheck lie. `revision` and `orderNumber` stay in
  the request only so that sentence is answered as the demo answers it.
- **`PUT /staff/kitchen/entries/:docketRef` without a `version` records the
  docket's first entry; with one, it corrects the existing entry through
  `claimVersion`** (A8). A second first entry is 409 "This docket already
  exists. Edit its existing kitchen entry.", whether it is seen by the
  service's check or, when two arrive together, by the unique `docketRef`
  index (the first entry is inserted before any stock moves, so the clash
  comes before a balance is touched). A `version` for a docket with no entry
  is 404 "Kitchen entry not found." (new; the demo turned an id that matched
  nothing into a create). No Idempotency-Key: a retried first entry is
  refused as a duplicate and a retried correction names a version the first
  attempt moved. The e2e races (two first entries, two corrections) fail
  when the check and the claim are removed.
- **A save moves the Kitchen by the old quantity less the new one for each
  item, through `StockLedgerService.move`, in stock item id order
  (`kitchenStockChanges`, `src/kitchen/kitchen-rules.ts`)** (plan §4.6): a
  first entry takes its portions (`KITCHEN_ENTRY`), a correction returns
  what it removed and takes what it added (`KITCHEN_CORRECTION`), with the
  docket ref as the movement's ref. An item short of stock refuses the whole
  save (409 "Insufficient kitchen stock for …"), so the kitchen cannot
  record portions the Kitchen never received. Id order means two saves
  sharing portions cannot deadlock. An empty list is allowed only to clear
  an existing entry (a cancelled docket); a first entry with none is "Add at
  least one item.".
- **A save is a manager's correction with a reason when the entry is dated
  away from its docket or from today, when its day is closed, or when an
  existing entry is from another day, from a closed day, or is moved to a new
  date** (`isKitchenCorrection`, the demo's `admin()` condition). The
  Kitchen is refused with the role sentence (403) and a manager without a
  reason with "An admin correction requires a reason." (400). The reason is
  optional in the request (`OptionalText`, not `@AdminReason`), because
  whether one is needed depends on the stored docket and day.
- **A kitchen day's close and the saves that check it take one advisory
  lock per date (`cnc:kitchen-day`): a save holds it shared for each date it
  touches, a close holds it exclusively.** Without it a close could commit
  between a save's "is the day closed?" read and its commit, and the
  Kitchen would have written into a closed day. The close is today in Lagos
  only, once: "Only the current kitchen day can be closed." (400) and "This
  kitchen day is already closed." (409, also from the unique date when two
  closes race; the e2e race fails when the check and the clash mapping are
  removed). Nothing on the till reads the day, so bills stay payable.
- **An entry's audit `ref` is its `KOT-` ref, and its `before`/`after` are
  the order number, revision, kitchen date and each portion by name.** The
  orders module's docket reader already lets the Kitchen, Cashier and
  Waiter read that history (plan §4.8), and the sentences read "Business
  Date changed from … to …." and "Lines updated (n).". A close is audited
  under the date, with the demo's `after` of "Closed"; it has no reader,
  because §4.8 does not open a day to non-managers.
- **The Kitchen Crosscheck is `crosscheck()` (`src/kitchen/kitchen-crosscheck.ts`),
  the demo's function result for result, computed on read
  (`GET /staff/reports/kitchen-crosscheck`, managers only; A20).** Seven
  results in the demo's order (missing, reference, revision, rule,
  quantity, matched, then unexplained entries), spelt `UPPER_SNAKE` (A5).
  A dish with no comparison rule is "Mapping required", never passed, and
  the rules are read as they stand now, as the demo reads them. Rows are
  the latest revision of every ref dated in the range (every revision of a
  ref carries its bill's date), in the order those revisions were written.
  One pure function, so the overview's Needs Attention count (C8) and the
  report can never disagree. Both read through one loader
  (`KitchenCrosscheckService.rows`, a range or every date): the report
  over its range, `notMatchedCount()` over every date (*The overview*).
- **A cash count's expected figure is the date's non-reversed `CASH`
  payments, refunds included, summed as `bigint` when the count is
  recorded, and the count keeps it** (plan §4.3; `src/cash/`). Payments are
  dated the day the money was taken (*Payments*), so the figure is that
  day's drawer; a later payment changes the next count's figure, never an
  earlier count's. The CHECK holds `differenceKobo` to counted − expected.
- **`POST /staff/cash-counts` takes an Idempotency-Key** (the *Idempotency*
  rule for creates): several counts per date are allowed, so a retry after
  a lost response would otherwise record the drawer twice. It is R(Cashier)
  (plan §6.2): the Cashier and managers; the report
  (`GET /staff/reports/cash`) is the same roles (plan §5.4, the Cashier's
  three reports). No `AuditRefAccess` reader is registered for `CASH-`
  refs, because §4.8's list does not include them; the Cashier reads counts
  through the report.
- **The two reports built with these cards sit under `staff/reports` and
  take `from`/`to` through `resolveDateRange` (today when absent, at most
  366 days).** C8's other reports join them there with the same range rule,
  so every report answers a bad range in the same words. *From C8-1:* all
  nine share `ReportPeriodQuery` (`src/common/dto/report-period.query.ts`)
  and `reportPeriod` (`src/common/report-period.ts`); see *Reports*.
- **A suite that closes a kitchen day or pins a date's cash figures runs on
  `createIsolatedDatabase`** (`test/kitchen.e2e-spec.ts`,
  `test/cash-count.e2e-spec.ts`). A close is one row for the whole database
  and the shared test database is reused on every run, so a close committed
  there would make every later kitchen save that day a manager's
  correction; and every suite takes cash on the shared database, so no
  expected figure could be pinned.

## Reports *(from C8-1)*

- **The nine reports are JSON reads under `/staff/reports/*`, computed on
  read from the stored rows the way the staff app's `reports.tsx` computes
  them from its local store** (plan §10, A20): `sales`, `payments`,
  `kitchen-crosscheck`, `stock-movements`, `waste`, `cash`, `transfers`,
  `maintenance`, `vendor-spend`. The screen keeps building its CSV from the
  rows (`staff/lib/exports.ts`), so the API never builds a file.
- **Every report takes one query class (`ReportPeriodQuery`) and one range
  rule (`reportPeriod`): `from` and `to` as Lagos business dates,
  inclusive, today when absent, at most 366 days, refused with
  `resolveDateRange`'s sentences.** The demo's `validatePeriod` checks the
  same two things (real dates, an end not before the start) on the screen,
  in its own words, before it asks; the API keeps the words its first two
  reports already answer, so all nine say a bad range the same way.
- **A record dated by an instant (a settlement, a movement, a waste entry,
  a requisition) is in the range from 00:00 in Jos on `from` to 00:00 in
  Jos the day after `to` (`ReportPeriod.start`/`end`, `watDayBounds`); one
  dated by a business date column (a payment, a cash count, a repair's
  reported date) is matched on the dates.** A bill settled at 00:30 in Jos
  is the next day's sale, though its UTC date is the day before; the e2e
  suite pins both sides of the midnight and fails with UTC day bounds.
- **An instant in a report's raw SQL is bound as ISO text and read as UTC
  (`(…::timestamptz AT TIME ZONE 'UTC')`, `utcInstant` in
  `reports.service.ts`), never as a Date parameter.** The columns hold UTC
  without a zone (*Data and migrations*); a zoned parameter would be cast
  in the session's zone, the hour-long drift TAY once shipped.
- **Every report pages its table like the first two
  (`{ data, page, pageSize, total, from, to }` and its own figures), and
  every figure beside the table covers the whole range, never the page.**
  The screen's Stat cards are range totals; a page-sized sum would change
  as the user pages.
- **Money is summed as `bigint` in SQL (plan §10), and a bill's VAT and
  service are rounded per bill by the till's own formula
  (`totalsFromSubtotal` in `order-totals.ts`, which `orderTotals` calls).**
  The demo rounds each bill's figures and adds the bills; summing VAT over
  the range first would differ by a kobo per bill, and a second copy of
  the formula in SQL would be one that drifts.
- **Sales departments are each line's (`departmentShares`): a bill whose
  lines are one department is wholly that department's, and a mixed web
  order gives the Bar its drinks' own totals at the bill's rates (the
  discount shared by subtotal), the bill's own department the rest** (plan
  §10, D30: "web drinks count as Bar"). *Decision (the plan leaves the
  split open):* the remainder rule makes the departments add up to
  Completed Sales to the kobo. With a department chosen, a bill appears
  when it has a line in it, with that department's share of every figure;
  the row's `department` stays the bill's own (its number's), and
  `departments` lists its lines'.
- **Q21: delivery fees are their own line (`deliveryFeesKobo`,
  `deliveryOrders`), never inside a sales figure, and they are reported
  whatever department is chosen**: a fee belongs to no department, and the
  bill's totals exclude it (*Staff Online Orders*: "the fee stays its own
  line outside the bill").
- **Still Owed is every open bill (Open or Payment) of any date, by the
  bill's department, after part payments (`balanceDueKobo`)**, as the
  demo's stat is: it is what is owed now, not what the range sold.
- **Sales by Item and by Category follow the menu's order (`MENU_ORDER`)
  and name each dish and staff category as they stand now**, as the demo
  reads them from its menu; quantities and money are the lines as sold,
  before order-level discounts.
- **Payments Received is every non-reversed payment dated in the range,
  refunds (negative) included, newest first, with its kind: `REFUND` for
  a negative payment of any method, `PART_PAYMENT` for a part payment,
  `ONLINE_CHECKOUT` for any other `ONLINE` payment, `FINAL_PAYMENT`
  otherwise.** The demo's rule plus `REFUND`, by the founder's decision of
  2026-10-25: the demo showed a card refund as an Online Checkout of a
  negative amount, which read as a sale. Daily Transfers is the `TRANSFER` rows of the same
  read, oldest first (the demo's list order).
- **Stock Movements, Waste and Maintenance History are answered by their
  own modules' services (`StockService.movements` with a time window,
  `WasteService.reportPage`, `MaintenanceService.reportPage`)**, so a row
  reads the same in the report as on its screen. Waste adds the Lagos day
  it was logged (the Date column) and lists every status, oldest first.
- **Vendor Spend lists every vendor in the order they were added, zero
  rows included; Purchases Received is the Fulfilled requisitions raised
  in the range, by line vendor (received packs × cost per pack), and
  Maintenance Cost the repairs reported in the range.** *Decision:* the
  demo dates a requisition by when it was raised (`p.at`), and the record
  has no received-at column; dating by the receipt would need the
  `PURCHASE_RECEIPT` movement, which the demo does not read.
- **Who reads which is the staff app's (plan §6.1): managers all nine; the
  Cashier Payments Received, Cash Reconciliation and Daily Transfers
  (`@Roles(CASHIER)`); every other role none (`@Roles()`).** The e2e suite
  walks every role over every report.
- **`test/reports.e2e-spec.ts` runs on `createIsolatedDatabase` and writes
  its bills, payments, movements, waste, purchases and repairs directly at
  chosen instants.** Every report sums the whole range, so another suite's
  row in the shared database would move its figures; the commands stamp
  the server's clock, and the suite is about how the reports read the
  records, not how the commands write them.
- **"Settled in the range" and "still owed" are one query each
  (`settledBills`, `openBills` in `src/reports/sales-records.ts`), shared
  by the Sales report and the overview**, with `utcInstant` and `kobo`.
  Two copies of either query would be two answers to "what did we sell
  today", and a manager reads both screens side by side.

## The overview *(from C8-1)*

- **`GET /staff/overview?from&to` is open to every active staff member,
  as the Overview page is (`canAccess`), and the role decides what comes
  back** (plan §5.3, §6.1; `src/overview/`). `scope` is `FULL` for the
  Owner and Managers (the manager overview, `overview.tsx`) and `BASIC`
  for every other role (the staff app's staff `Overview` in
  `workspace.tsx`). The demo shows the two screens to the same split.
- **A manager gets only the widgets their saved layout shows
  (`ShellService.overviewPreferences`: the Service preset when none is
  saved), in the layout's order; a hidden widget is `null` and costs no
  query.** The layout is already per person on the server (*Optimistic
  concurrency*), so the poll computes what is on that person's screen and
  nothing else. After `PUT /staff/me/preferences/overview` the screen reads
  the overview again.
- **Every other role gets the Service preset's eight widgets for today,
  whatever `from` and `to` say, with plan §6.1's row filters:** a
  Bartender's Settled Sales, Outstanding Bills and Open Orders are the
  Bar's (*decision*: §6.1 says "Overview ✓ (Bar)"; the demo filtered only
  the bills owed, and §6.1 is the approved record); Kitchen gets today's
  kitchen entries (`kitchenEntries`) in place of sales, as the demo does.
  The staff screen has no period, so a range would be a figure nobody
  sees.
- **Needs Attention lists a line only for a role whose page the line
  opens, and counts what that page would show the reader** (the demo's
  `canAccess(actor.role, x.page)` filter, then §6.1's row filters):
  Purchase Requisitions and Waste Awaiting Review (Approvals; managers;
  the approvals counts, `pendingCount()`); Kitchen Crosscheck (managers
  only: *decision*, the Cashier opens Reports but may not read that
  report); Open Stock Requests (Pending or Partially Issued, a Bartender's
  or Kitchen user's own location, `scopedStockLocation`); Tasks in
  Progress (not Done, as Tasks shows them to the reader, `visibleTasks`;
  *decision*: only for roles that open Tasks, so a Waiter or Bartender is
  never sent to a page that refuses them, the bell's rule).
- **Kitchen Crosscheck counts the rows that are not Matched dated from
  366 days back (today included) on** (`notMatchedCount`, the report's
  `REPORT_MAX_DAYS`; later dates too, as a web order's slot may be
  tomorrow): an exception stays until someone puts it right or it is a
  year old, and a manager may record an entry for an old date. It reuses
  the report's loader, never a second copy of the comparison.
  *Decision* (C8 review): the demo's `crosscheck(s)` ran over its whole
  store, which a browser kept small; over every date the count read every
  docket ever written, with its items, on every manager's poll (*measured,
  C8-1:* about 50 ms for a month of history, 3,100 dockets, and about
  520 ms for a year, 36,500, growing without end). Bounded, it stops
  growing after the first year, at about the year's figure. If it must be
  cheaper still, count it in SQL with a parity test against
  `crosscheck()`; do not hand-copy the rules.
- **Settled Sales, the Sales Trend and Restaurant and Bar Sales read the
  bills settled in the range by their Lagos settlement date
  (`settledBills`); departments are each line's (`departmentShares`), as
  the Sales report's are** (*decision*: the demo split by the bill's own
  department, which is the same for every till bill; D30's web orders mix
  both, and the overview must agree with the Sales report to the kobo). A
  bill's total includes VAT and service and excludes the delivery fee
  (Q21), the chart's own note.
- **The trend is hourly for one day, daily up to 62 days and monthly
  beyond, in Lagos time (`overview-trend.ts`, the demo's loop and labels:
  `00:00`, `1 Oct`, `Oct 26` from `toLocaleDateString('en-GB', { timeZone:
  'UTC', … })`).** A sale is filed by its Lagos hour or settlement date,
  so 00:30 in Jos is the new day's `00`. The labels come from the server's
  ICU; September is `Sep` or `Sept` by ICU version, as in browsers.
- **Payment Methods is the non-reversed payments dated in the range on
  the bills settled in the range, by method, in the order each method was
  first taken** (the demo's `Map`): refunds and delivery fees included,
  reservation credit excluded (it is not a payment). Bestselling Items is
  the top five dishes by quantity, under the name first sold in the range,
  ties by name (`localeCompare`).
- **The "now" widgets ignore the range:** Outstanding Bills and Open
  Orders are every open bill of any date (`openBills`, newest first, five
  shown); Occupied Positions and Service at a Glance are the active tables
  as Reception's floor shows them today (`floorStatus`, so a Checked In
  booking holds a table as Reserved, the floor's rule); Expected and Next
  Arrivals are today's Confirmed bookings by time, with no phone or email;
  Low Stock is each Kitchen item's Kitchen balance and Bar item's Bar
  balance below its minimum, lowest first, ties in the order added, eight
  shown and the total; Tasks in Progress the six oldest not Done.
- **Range rules are the reports' (`reportPeriod`, "The overview", at most
  366 days)** (*decision*: the demo's custom range had no cap; one rule
  for every range read keeps one set of sentences, and a year is the
  longest range the reports read too).
- **Cost: every widget is a fixed number of queries, whatever the data,
  run one after another, never in parallel.** A poll must not hold all
  three pooled connections the till needs. A fixed number of queries is
  not a fixed cost: each read's time follows the rows it must reach, so
  every range read goes through an index on what it filters by (the
  settled bills by `Order(status, settledAt)`, C8 review) and the one
  read without a range, the crosscheck count, is bounded to a year.
  *Measured (C8 review, local Postgres 16, a year of history: 54,900
  settled bills, 109,800 lines):* the settled bills query for today took
  1.3 to 1.6 ms through `Order_status_settledAt_idx` and 11.6 to 31.8 ms
  scanning every bill without it, a cost that grew with every day of
  history; 25 days took 20 to 28 ms with it. That is the query alone,
  not the whole poll. *Measured (C8-1, local
  Postgres, a seeded month: 4,650 bills, 10,912 lines, 4,640 payments,
  3,100 dockets):* the full layout is 25 queries (two of them the guard
  and the layout); Today median 66 ms, This Month 114 ms, 31 days 136 ms;
  five at once about 200 to 460 ms. The Service preset is 19 queries,
  58 ms. The costly reads are the range's settled bills (about 45 ms for a
  month) and the crosscheck count (about 50 ms); every other widget is
  under 25 ms.
- **`test/overview.e2e-spec.ts` runs on `createIsolatedDatabase` with a
  fixed clock (12:00 in Jos on 21 October 2026) and writes its records
  directly.** Its "now" widgets read the whole database (open bills,
  tables, stock, tasks, the crosscheck over the last year), so another
  suite's row would move them; it retires the seeded tables and zeroes the
  seeded stock minimums for the same reason.

## The staff bell *(from C8-2)*

- **`GET /staff/notifications` ports `staff/lib/notifications.ts` item by
  item, in the demo's order and words, with the items built before it in
  the places C7-7 gave them** (plan §9.1; `src/notifications/`). The
  order: Purchase Approval, Waste Approval, Low Stock, Unsettled From a
  Previous Day, Online Order, New Web Docket, Checkout Needs Attention,
  Stock Request, Free Table Reminder, Expected Guest Arrival, Assigned
  Task; within a kind, oldest first (the demo's lists in the order they
  were added; Low Stock by item, the Store before the item's own
  location). The screen shows the list as it comes, so the order is the
  contract.
- **Who gets what is the demo's, with §9.1's table:** approvals for
  managers; Low Stock for managers and the Storekeeper; unsettled bills
  for managers and the Cashier; online orders for the Cashier; the New
  Web Docket for the Kitchen and managers; held checkouts for managers;
  open stock requests (Pending or Partially Issued, every location) for
  the Storekeeper only; the Free Table Reminder and arrivals for
  Reception and managers; tasks for whoever they are assigned to. A
  Bartender and a Waiter get none of these, as in the demo.
- **Every kind is offered only to a role whose `pagesFor` includes the
  kind's page, so every item opens.** The role conditions above already
  say so; the filter keeps it true if a role's pages change, and it is
  what keeps a task held by an account re-roled to Waiter off a bell
  whose Tasks page would refuse it.
- **The four switches are `Settings.alertApprovals`, `alertLowStock`,
  `alertUnsettled` and `alertArrivals`, read on every poll** (the demo's
  `ALERTS`, saved by `settings.save`). A switch hides its kind for every
  reader at the next poll. The Free Table Reminder, the online items,
  stock requests and tasks have no switch, as in the demo.
- **While the approvals alert is on, a manager's bell leaves out a task
  linked to a purchase whose title starts "Review"** (the demo's rule):
  the Purchase Approval already asks for that decision, and two items
  for one decision would be counted twice on the badge. With the alert
  off the review task comes back, because then it is the only reminder.
  Other purchase tasks ("Receive goods for …") always show.
- **Low Stock follows `isLow` and the demo's loop: every stock item,
  active or not, at the Store (under one pack) and at its own location
  (the Kitchen, or the Bar for a Bar item; under its reorder level), a
  missing balance being zero.** The detail is the demo's: "Rice · 0 bags
  left" at the Store, "Rice · 3 portions left, reorder level 15"
  elsewhere, with the demo's plural (an "s" unless exactly one). The
  Bartender is not given it, as in the demo; the Stock screen shows the
  Bar its own low flags.
- **Unsettled From a Previous Day is an Open or Payment bill
  (`UNSETTLED_ORDER_STATUSES`) whose business date is before today's in
  Lagos (`watToday`)**, both departments; Expected Guest Arrival is a
  booking Confirmed for today, "Name · 19:00 · 4 guests" (the demo says
  "guests" for one too), in the order the bookings were taken.
- **The filters are the owning modules' own** (`AWAITING_APPROVAL` from
  Purchasing, the Approvals count's; `OPEN_REQUEST_STATUSES`, which the
  overview now uses too; `UNSETTLED_ORDER_STATUSES`;
  `ACTIVE_ONLINE_STATUSES`), so "pending" on the bell and on the screen it
  opens are one definition. The new items' words are
  `src/notifications/staff-bell-items.ts`.
- **A poll is bounded by construction: one settings read, then for each
  kind the reader gets an indexed `COUNT` and, only for the kinds the
  requested page overlaps, an `OFFSET`/`LIMIT` read** (`pageOfSources`,
  `bell-sources.ts`). `total` stays exact and at most `pageSize` (100 at
  most) rows are read, whatever is pending; the kinds run one after
  another, never in parallel, so a poll holds one pooled connection.
  Every signed-in device polls every 30 seconds, and a bell that loaded
  every row would cost what the backlog is. The Free Table Reminder is
  loaded whole (at most one per table). *Not measured:* the New Web Docket
  count checks every web docket of a day not closed against the kitchen
  entries; a day the kitchen never closes keeps its dockets in that
  count. If it ever shows in a poll's time, bound it to the open kitchen
  days rather than change what rings.
- **`test/staff-bell.e2e-spec.ts` runs on `createIsolatedDatabase` with a
  fixed clock and the real seeds**, because the bell reads the whole
  database: it gives the seeded Bar items one Store pack and a zero
  reorder level so only its own items are low, places the web order and
  the held checkout through the real checkout and the signed fake
  webhook, and checks every role's whole bell, each switch, the paging
  and the items leaving. **A suite looking for one bell item reads every
  page (`test/staff-bell.ts`, `readBell`)**: with the seeds, a manager's
  or the Storekeeper's bell starts with a Low Stock item for every seeded
  Bar item (none holds stock), more than one page.

## Reception: bookings, table sessions and the floor *(from C4)*

- **Every booking, whatever its channel, is made by
  `ReservationsService.book` (`src/reception/reservations.service.ts`);
  the booking's `source` decides which arrival rules bind it and in whose
  words a clash is answered** (plan §7.5: "Website, app and Reception all
  run one command"). Reception's route calls it, and so do the website's
  and the app's (`POST /reservations`, C6-5); two booking paths would be two sets of checks that
  drift, and a race between a web booking and a Reception booking for one
  table must meet the same lock and the same index.
- **The arrival rules are `arrivalProblem` (`src/reception/reservation-rules.ts`),
  pure and in this order: in the future, on an open day, within the day's
  opening hours, and online only on the arrival grid and no later than the
  last arrival** (Q30's default: Reception is limited to the opening hours,
  08:00 to 23:59; the 30-minute grid and the 23:00 last arrival bind the web
  and the app only). The large-party rule (`bigPartyProblem`, the website's
  own note) binds the web and the app only too: Reception is the team those
  guests are sent to. Pure, so the time rules are unit-tested at fixed
  instants rather than waiting for a clock.
- **One active booking per table and date is decided by the partial unique
  index `Reservation_tableId_businessDate_key`, and its clash is answered
  409 with the domain's sentence, never 500** ("This position is already
  reserved for that date…" for Reception, the website's "Someone has just
  taken this place…" online). The service checks first only so the demo's
  sentences come in the demo's order. The e2e race (five bookings at once,
  one 201) still passes with the check and the table lock removed, and
  fails with the clash mapping removed: the database, not the check, is
  what refuses the second booking.
- **Every command that books, seats, locks, checks in at, moves a booking
  to or frees a table takes that table's advisory lock first
  (`lockTables`, namespace `cnc:table`, in id order), before it claims any
  row.** Some of the demo's checks span two kinds of row (a booking for
  today against guests seated now; a walk-in against today's booking), and
  no index spans a booking and a seating, so without the lock two commands
  could both pass. Taking it before any row lock, in id order, means a
  booking moved between two tables cannot deadlock a command on either.
  The partial unique indexes stay the backstop for each kind on its own.
- **Every reservation command names the booking's `version` (A8); a
  release names the seating (`sessionId`) and its `version`.** Seatings
  are new rows that each start at version 0, so a version alone would let
  a release pressed on a stale screen free the guests seated after it.
  `table.allocate` and check-in create seatings and take no key: a retry
  is refused by "Release this position before allocating it again." or a
  stale version. `reservation.create` takes an Idempotency-Key (A9).
- **`table.release` is refused while any bill on the table is Open or
  awaiting payment, of any date, and completes the table's Checked In
  bookings, moving their `version`** (plan §7.1 step 6, §7.5). A booking
  another device holds has changed status under it, so that device's next
  write must be told to refresh; nothing frees a table by itself (D20).
- **The floor's status is `floorStatus` (plan §7.5): Locked whenever a
  Locked seating holds the table, Occupied for guests seated today only,
  then Reserved for a Confirmed or Checked In booking on the date, else
  Available.** A seating is now, so it does not make a future evening
  look taken. The Point of Sale roles read today's floor only, without a
  guest's phone or email, and a Bartender sees Bar bills only (plan §6.1).
- **The Free Table Reminder is computed on read from open Occupied
  seatings at least `Settings.freeTableReminderMinutes` old, worded in
  minutes under an hour (D37), and served on `GET /staff/notifications`**
  (`src/notifications/`). The bell is C8-2's card, but the C4 gate's step
  11 needs the reminder, so the route starts with this one item and C8-2
  adds the rest of plan §9.1 beside it, each with its own roles (done:
  *The staff bell*); the floor's seating carries `reminderDue` for the
  same rule.
- **A guest's phone is kept as `guestPhone` writes it: a Nigerian mobile
  number in its one form (`0` plus 10 digits) however it was typed, any
  other number as typed; a guest's email is trimmed and lower-cased.** The
  demo only required a phone, and a visitor's foreign number must still
  book; a Nigerian number in one form is what the search and the Q35 link
  can match.
- **A Reception booking links to a customer only on an exact match to a
  verified email, else a verified phone, and never creates one** (Q35's
  default). A change re-tries the link only when the booking has none and
  its contact changed; it never unlinks, so a booking already in a
  customer's app stays there.
- **A table's audit `ref` is the room's initial and its code (`D-B1`,
  `L-TS1`, the demo's table ids); a booking's is its `RSV-` number. No
  `AuditRefAccess` reader is registered for either** (plan §4.8's list of
  records a non-manager may read does not include them, so the registry's
  fail-closed answer is the rule). Codes repeat across rooms (TS1 to TS3),
  so the code alone is not one table.
- **`reservation.change` (new; plan §16) changes only the fields sent and
  checks again only what they touch**: the places when the table or party
  changes, Reception's arrival rules when the date or time does, and the
  table's holds when the table or date does. A name fixed on a booking
  whose time has passed is not refused for being in the past.
- **The reception suite runs on `createIsolatedDatabase`
  (`test/reception.e2e-spec.ts`).** It changes the opening hours and the
  reminder time, which every suite shares, and asserts on the whole floor
  and the whole bell. Bookings already past their time and guests seated
  hours ago are written directly, since the routes refuse to make them now.

## Bookings from the website and the app *(from C6)*

- **`POST /reservations` is the website's and the app's booking, and it
  runs `ReservationsService.book`, the command Reception's route runs**
  (`CustomerReservationsService.book`, plan §7.5). So the table lock, the
  checks and the partial unique index decide a race between any two
  channels; `test/customer-reservations.e2e-spec.ts` races five website
  bookings for one table and date (one 201) and a website booking against
  Reception's (one wins, each refused in its own words).
- **The route is public or customer (`OptionalCustomerGuard`,
  `@MaybeCustomer()`).** No `Authorization` header is a guest: source
  `WEB`. A customer token makes the booking source `APP` and the
  customer's own. A header that fails is 401 and a staff token 403, never
  a silent guest booking, so an app whose token expired refreshes and
  retries instead of making a booking that is not in the account. The
  source is decided by the server from the session, not sent by the
  client; the website and the app have the same rules (Q30), so the label
  only says where a booking came from.
- **The table is named as the public floor plan names it: `venue` (slug)
  and `table` (code)**, never a row id (*The public reads*). A room or
  table that does not exist is the command's "Choose a position with
  enough capacity." (400), its answer to "no such table".
- **The guest's details are checked with the website form's sentences**
  (`TableBooking.tsx`): "Please add a name for the reservation.", "Please
  add a Nigerian phone number, for example 0803 123 4567.", "Please add a
  valid email address so we can send your confirmation.". The phone must
  be Nigerian, as the form requires (Reception may still take a foreign
  number), and is stored as `0` plus 10 digits through `customerPhone`, so
  `234…` without the plus, which the form accepts, is accepted too.
- **To a website or app guest every hold on a table is "Someone has just
  taken this place for that time. Go back to the floor plan and choose
  another."** (`holdMessages`): another booking, a lock and guests seated
  alike. The floor plan showed the table free, so it is the same race, and
  why a table is locked is staff knowledge. Reception keeps the demo's
  three sentences.
- **`POST /reservations` takes an Idempotency-Key (A9), scoped to the
  customer or, for a guest, to the hashed address**; a guest's retry comes
  from the same address. It is limited to 30 bookings per address in 15
  minutes in memory (`BookingThrottle`, 429 "Too many attempts…"), the
  first line only: it needs no sign-in, holds a table for a whole date
  and sends an email. *From C8-3 the count is stored, not in memory.*
- **The real limits are stored caps on website and app bookings (from the
  C6 review): 20 a day per client address (`Reservation.ipHash`, the
  address hashed by `hashClientAddress`) and 10 a day per email, from any
  address (`assertOnlineBookingCaps`, `booking-throttle.ts`), 429 "Too many
  attempts…".** The in-memory count is per instance and forgotten on a
  restart, and allowed one address some 2,880 table-dates a day: enough
  to hold every table for weeks, or mail a stranger 120 confirmations an
  hour from CNC's sender. Counted under advisory locks on the address and
  the email (keys only this check takes, in a fixed order, before the
  table's lock, so they cannot deadlock with the table or email locks),
  against `createdAt` written on the service's clock (A11). Reception's
  bookings are never counted. **No cap per phone**: CNC sends no SMS, made-up
  numbers cost a script nothing, and a cap would refuse a family booking
  under one number. **Still open, for the founder:** how far ahead a guest
  may book. The website offers any future date and the plan sets no
  horizon, so the server sets none; a horizon (for example 60 days) would
  bound what the address cap still allows, and is a business rule, not
  this build's to set.
- **Linking a booking to a customer is one module, `customer-link.ts`,
  both ways, on an exact verified match only, never creating an account**
  (Q35, A15). A booking made without a session (Reception's, a website
  guest's) links to the customer holding its verified email, else its
  verified phone. A customer who proves an email with a code (the first or
  any sign-in, an email change) collects the unlinked bookings under it,
  which is what the website's done screen promises ("Sign in with the
  phone number or email you gave"). A linked booking is never moved. Both
  directions take the email's advisory lock (`lockCustomerEmail`), so a
  booking and a first sign-in for one address at once still end linked.
  The link does not move a booking's `version`: no screen edits it.
- **The locks are always taken in one order: the table's, then the
  email's, then the booking's row** (from the C6 review). A first sign-in
  holds the email's lock and then updates the email's unlinked bookings'
  rows, so Reception's change of an unlinked booking takes the email's
  lock (for the email it will link by) after the table's and before it
  claims the booking's version, which locks the row; the other order could
  deadlock the two, a 500 for Reception or the guest. `customer-reservations`
  holds the email's lock and checks the row stays free while the change
  waits (seen failing with the old order).
- **A customer sees only the note they wrote (`guestNote`), never
  Reception's (`note`)** (from the C6 review). Reception's note is staff
  writing to staff ("ask for card up front"), and Q35 links phone bookings
  to accounts, so `GET /me/reservations` showed it to the guest. An online
  booking writes the guest's "Anything we should know?" into both
  columns, so Reception still reads it and may add to `note` without the
  guest seeing that; a Reception booking's `guestNote` is blank. The C6
  review migration copied an online booking's existing note across.
- **`GET /me/reservations`, `PATCH /me/reservations/:id` and `POST
  /me/reservations/:id/cancel` touch only the customer's own bookings
  (`customerId`); another customer's booking, or none, is 404 "We could
  not find that reservation."** (the account app's sentence), checked
  before the version is claimed, so a stranger's request cannot learn
  that a booking exists or move its version. Seen failing with the
  `customerId` condition removed.
- **The 24-hour rule (Q6) is enforced on the server for change and
  cancel: allowed while the booking starts at least 24 hours from now,
  refused after with 409 and the app's words** ("Your reservation is less
  than 24 hours away. Nothing is charged, but please call CNC if you can
  no longer come."). Exactly 24 hours is allowed ("≥ 24 h"; `insideChangeWindow`,
  unit-tested at the millisecond); the e2e suite moves the faked clock a
  minute either side. It judges the booking as it stands, not the new
  time: a booking may be moved closer than 24 hours, after which it can
  no longer be changed online, as the demo's `updateReservation` allowed.
  Staff are not bound by it. Each booking in the list carries
  `changeableUntil` and `changeable` from the server's clock (A11), so the
  app disables its buttons without trusting the phone's clock.
- **A customer's change keeps the table and changes only the date, the
  time and the party** (the app's form; for another table it says cancel
  and book again), and checks what it touches with the online rules: the
  large-party note, then "<Table> seats up to <n>. For a larger party,
  book a bigger table.", the arrival on the grid ("Choose an arrival time
  that is still open."; a closed day keeps "CNC is closed on that date."),
  and on a new date the table's holds ("<Table> is already taken at that
  time. Try another time."), the index answering a race in the same words.
  Change and cancel name the booking's `version` (A8).
- **Every booking emails its guest: the confirmation on any channel's
  create, and a notice on a cancel (the customer's or Reception's) and on
  a change of the table, date, time or party** (`ReservationMail`, plan
  §9.2). Confirmations always go to the email given (Q31's default). Each
  is queued in the command's transaction and sent after the commit; the
  dedupe key is the booking and the event, a change's carrying the new
  `version`, so a replayed create sends nothing more
  (`OutboundMessagesService.dispatchByKey`). A booking with no email (an
  anonymised one) is sent nothing. Reception's cancel and change are
  pinned by `customer-messages` (the email, its row reaching `SENT`, the
  in-app item; seen failing with either enqueue removed).
- **CNC's phone goes into an email as the website shows it, `0802 218
  8797`, never the stored digits** (`phoneForDisplay`,
  `common/nigerian-phone.ts`; the site's `phoneDisplay`; Q6 says the
  number is shown formatted) (from the C6 review). The guest reads and
  dials the same number on the site and in the email.
- **Audit: a customer's create, change and cancel are `CUSTOMER` rows;
  a website guest's create is a `SYSTEM` row named "Website guest
  <name>"**, the `AuditLog_actor_check` allowing no customer without an
  id. Online rows carry the channel (`WEB`/`APP`); Reception's rows are
  unchanged.

## The customer's in-app list and booking reminders *(from C6)*

- **`GET /me/notifications` and `POST /me/notifications/read` are the
  account app's inbox; the items are written by the same events that send
  email, in the event's own transaction** (plan §9.2, card C6-8;
  `CustomerNotificationsService.record`). Today: the welcome when a
  customer is created, and a booking made, changed, cancelled and
  reminded. C7 adds orders through the same service. The item's
  `dedupeKey` is the email's, inserted with `ON CONFLICT DO NOTHING`, so a
  replay writes nothing and a repeat never aborts the command. A deleted
  account (Q36) gets nothing.
- **The words are the account app's demo's** (`lib/account/api.ts`
  `listNotifications`): "Welcome to CNC", "Table reserved", "Reservation
  cancelled", "See you soon", and the body "<table>, <room>, <date> at
  <time>.". "Reservation changed" is new, and the reminder names the
  booking's date and time where the demo, building items on read, said
  "today or tomorrow". `customer-notification-texts.ts` holds them, pinned
  by its spec. `link` is a path under the site's base (`/account#reservations`),
  never a full URL, so a stored item does not go stale with a domain.
- **Booking items are written by `ReservationMail`, beside the booking's
  email, for a booking that belongs to a customer**: whatever channel made
  it, a Reception booking linked by Q35 included. A guest's booking writes
  no item: there is nobody to show it to.
- **The list is a history, not a message: preferences do not gate it**
  (D62). What a customer switched off by email still appears here, because
  nothing here interrupts anyone.
- **Unread is "created after `Customer.notificationsReadAt`"** (plan §4.2),
  and both instants are the service's clock (A11): `record` writes
  `createdAt` itself rather than taking the database's default, so a
  difference between two clocks cannot make a new item read. `markRead`
  never moves the instant back. The page is the standard
  `{data,page,pageSize,total}` plus `unread` (all pages) and
  `notificationsReadAt`; each item says `unread`. `no-store`, as every
  `/me` answer.
- **Reminders (Q32's default) are the reminders sweep's
  (`ReservationRemindersService`, `POST /internal/sweeps/reminders`, every
  15 minutes)**: a Confirmed booking is reminded once, 24 hours before it
  starts (`REMINDER_LEAD_MS`, its own constant beside Q6's
  `CHANGE_WINDOW_MS`, because the founder answers them apart), until it
  starts; guests by email; a customer who switched Reservation Reminders
  off (`prefBookingReminders`) gets the in-app item and no email.
- **"None for bookings made less than 24 hours ahead" is decided when the
  booking is made or moved, not by the sweep**: the booking command and
  both change commands set `reminderSentAt` to now when the (new) start is
  under 24 hours away, and to null otherwise (`initialReminderStamp`). One
  rule then covers a booking made late, a booking moved closer (no
  reminder of a time just chosen) and a reminded booking moved further out
  (it gets a reminder for the new time; its dedupe key carries the
  `version`). Exactly 24 hours ahead still gets one, as Q6 still allows a
  change then.
- **Bookings made before C6 were stamped by the C6 review migration by the
  same rule** (`20261022215055_c6_review_fixes`): a Confirmed booking whose
  start (its date and arrival in Jos) was under 24 hours after its
  `createdAt` gets `reminderSentAt = createdAt`. Nothing before C6 wrote the
  column, so without it the first reminders sweep on staging would have
  reminded C4 and C5 bookings made late, which Q32 excludes. A booking made
  a day or more ahead keeps null and is reminded, as Q32 asks. Checked on
  the boundary (exactly 24 hours ahead is not stamped) before it was
  applied.
- **Each reminder is claimed by one conditional update (`reminderSentAt IS
  NULL`, still Confirmed) in the transaction that writes its messages**,
  and the email's dedupe key is the booking, the event and the version, so
  two sweeps at once remind once (the e2e suite races two, three rounds)
  and a booking cancelled first is not reminded. One booking's failure is
  logged by id and left unclaimed for the next run.
- **The reminder is the one sweep whose work is a feature, and still no
  other behaviour depends on it** (*Auth*: no behaviour may depend on a
  sweep having run): if the job does not run, reminders are late or
  missed, a courtesy lost, while bookings, changes and the 24-hour rule
  are unaffected. A booking whose start has passed is never reminded late.

## Web push *(from C10)*

Built on the founder's instruction of 2026-10-27 ("let the things that
require push notifications on all dashboards or roles have them"), which
amends the plan's "Web push is not built at launch" (§9.1, §11). The bell
and the in-app list reach only someone with the app open; a paid web order
or an order ready for pickup has to reach a phone in a pocket. The code is
`src/push/`, with the clock's pushes and the push sweep in `src/internal/`.

**The decisions, each with its reason:**

- **D1: a durable queue table, `PushMessage`, written in the event's own
  transaction and isolated inside it.** The pure work (gate, render, clip,
  tag, TTL, the topic) runs first inside a `try` that answers null; an
  input may be passed as a builder so a brand constructor that throws costs
  the push, not the event (`PushInput`). The database part runs inside
  `SAVEPOINT cnc_push` (`withPushSavepoint`, constant SQL only): any error
  rolls back to the savepoint, logs ids only and answers null. A committed
  event always has its push row, and a push defect can never roll back the
  caller: `createMany({ skipDuplicates })` alone covers only a duplicate,
  and a foreign key, a CHECK, an over-long value or a failed read would
  abort the whole transaction, PS1's being the Paystack settle.
- **D2: text is rendered when the row is queued and stored on it, from
  branded inputs only** (`push-input-types.ts`: ids, order, docket and PO
  numbers, WAT date and time labels, names from staff-managed lists, plus
  counts and enums). A retried or held push needs no event data. A plain
  `string` input field, or one named `name`, `title`, `phone`, `email`,
  `address`, `note` or `reference`, fails `npm run build`
  (`PUSH_INPUTS_HAVE_NO_FREE_TEXT`), so the privacy rule below is
  structural, not sample-tested. The build's assertion guards the real
  catalogue; the spec's `@ts-expect-error` cases guard the machinery
  behind it (`WithoutFreeText`), which could otherwise break so that the
  assertion checks nothing. ts-jest only transpiles here
  (`isolatedModules`) and the build leaves specs out, so those cases are
  checked by CI's lint job, `npx tsc -p tsconfig.json --noEmit`, where an
  unused `@ts-expect-error` is an error.
- **D3: a row is queued only for an owner who holds at least one device**,
  checked in the same savepoint. Most customers never subscribe, and a row
  nobody can receive is only a write.
- **D4: revocation ends a subscription; plain session expiry does not.**
  `CncTokenService.revokeAllForSubject` calls `forgetPushSubject` through
  the same client (`TokenWriter` widened), deleting the realm's
  subscriptions and the owner's PENDING and FAILED rows. Sign-out on every
  device, a role, email or status change, a password change or reset and
  a reused refresh token all revoke already, so one place covers every
  path. Expiry is left out on purpose, so the 24-hour reminder still
  reaches a customer who has not opened the app for a week. **Binding a
  device needs a live refresh token** (401 "Your session has ended. Sign
  in again."), read `FOR SHARE` so a sign-out running at the same moment
  either commits first or forgets the device after: an access token
  outlives its revocation by up to 15 minutes and must not re-bind.
- **D5: no client-side unbind before sign-out.** The browser keeps its
  `PushSubscription` and the server drops the row. This removes TAY's
  race between the unbind and the sign-out, and the gap where no token is
  left to unbind with.
- **D6: customer pushes are never held; a non-urgent staff push to someone
  off duty, outside the staff window, is held to the window's opening**
  (`retryAfter`, `holdUntil`, `push-window.ts`), and its expiry runs from
  the release. The window is the Lagos day's `OpeningHoursDay` hours
  widened by `STAFF_WINDOW_GRACE_MIN` (60) each side; a week with no open
  day falls back to 07:00–22:00 WAT. D8 falls back to "all active holders"
  exactly when nobody is clocked in, which is at night, and a 23:30 stock
  request should not wake a storekeeper at home. Urgent events (PS1, PS2,
  PS3) are never held: a paid web order or a held payment must reach
  someone. Customer pushes come from staff actions during service or the
  reminder of an in-hours booking, and TAY's fixed 05:00–23:00 window would
  hold a 22:30 "ready for pickup".
- **D7: no new customer preference.** Pushes follow `prefOrderUpdates` and
  `prefBookingReminders` (the entry's `gate`), and the per-device control
  is the opt-out. A second global switch would duplicate the device
  control. D62 holds: the in-app list is never gated.
- **D8: each staff event names its `audience`, and a role receives it only
  when it is in the audience and `pagesFor(role)` opens the event's page**
  (`roleReceives`, `staffPushEventsFor`). The role chain is: the role's
  holders on duty, else every active holder, else every active Owner and
  Manager (`staffRecipients`). On duty is an open shift (`timeOut` null)
  begun within 16 hours (`ON_DUTY_WITHIN_MS`), so a shift left open by a
  forgotten scan does not keep its owner "at work" for days. Page access
  alone would give Waiters the unsettled bills, the Kitchen and the Bar
  the stock alerts, and the Cashier the held payments. If the restaurant
  scans attendance, people at home stay quiet; if it does not, the alert
  still reaches someone. The actor is always excluded.
- **D9: staging and production have separate VAPID pairs, and CNC never
  uses TAY's** (*Configuration*). A leaked staging key cannot push to
  production devices. `tayxcnc.com/cnc` serves staging until go-live, so
  the same origin moves from the staging key to the production key then;
  D12 handles that.
- **D10: the public key is served on authenticated routes only**
  (`GET /me/push/public-key`, `GET /staff/push/public-key`). The control is
  shown only to signed-in people, and the staff client has no unauthenticated
  request; no unauthenticated surface is added.
- **D11: the recipient is checked again at send.** Staff must still be
  active, in the event's audience and able to open its page; the customer
  must not be deleted. Otherwise the row is `DROPPED` / `RECIPIENT_GONE`.
  The same reason as A14's guard re-reading `Staff` on every request.
- **D12: a key mismatch is detected, never retried.** At boot the private
  key must derive the public key; a subscribe carries
  `applicationServerKey` and is answered 409 when it is not the current key
  ("This device's notifications were set up for a different key. Turn them
  on again."), comparing the decoded bytes, not the text, so a browser
  that pads the same key is not told to turn notifications on again; the client compares keys and re-subscribes; at send, 401 or
  403 from a push service is `KEY_MISMATCH` and deletes that device, as a
  404 or 410 (`GONE`) does. Otherwise the staging-to-production move, a
  rotation or swapped secrets would spend three attempts per device per
  push forever while the control said "On".
- **D13: endpoints are limited to known push-service hosts**
  (`PUSH_SERVICE_HOSTS`, `pushEndpointProblem`, `push-hosts.ts`), checked
  at subscribe and again by `WebPushSender` before every send. Otherwise
  the service would POST to any address a signed-in person stores: internal
  and metadata addresses, a blind probe read through the push's outcome,
  and a VAPID token signed for any audience. The second check means a row
  written before a host left the list is never contacted.
- **D14: pushes are sent inline only inside an HTTP request**, after its
  commit and awaited, under one shared `PUSH_DISPATCH_BUDGET_MS` (3 s)
  deadline per request (staff and customer commands, the Paystack webhook,
  the confirmation read). The payments and checkouts sweeps collect their
  topics and dispatch once at the end under one 3 s deadline. The reminders
  sweep and PS8 only queue. The push sweep delivers everything else. Cloud
  Run throttles the CPU after the response, so nothing is fire-and-forget,
  and one deadline per request or run stops it growing with a push
  service's latency.

**The events** (`PUSH_CATALOGUE`, `push-catalogue.ts`, the one place each
push's words, audience, urgency and lifetime are written). `about` is the
topic and the middle of `dedupeKey` (`<event>:<about>:<c|s>:<ownerId>`):
the existing mail or list key where one exists, versioned, so a legitimate
repeat (a second staff change, a purchase back to Pending) pushes again
while a retried command does not.

| Code | Event | Raised by | Who | Switch | Urgent | Lifetime |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PC1–PC3 | `order.preparing`, `order.on_the_way`, `order.ready` | a web order's stage change (`OnlineOrderMail.statusChanged`) | the order's customer | `prefOrderUpdates` | PC2, PC3 | 2 h, 2 h, 4 h |
| PC4 | `order.cancelled` | the same, Cancelled | the customer | none, as its email | no | 24 h |
| PC5 | `order.refunded` | `OnlineOrderMail.refunded` | the customer | none | no | 72 h |
| PC6 | `reservation.booked_for_you` | a Reception booking for a customer | the customer | none | no | until the start, at most 24 h |
| PC7 | `reservation.changed_by_staff` | a staff change | the customer | none | no | until the start, at most 24 h |
| PC8 | `reservation.cancelled_by_staff` | a staff cancel | the customer | none | no | 24 h |
| PC9 | `reservation.reminder` | the reminders sweep, queue only | the customer | `prefBookingReminders` | no | until the start |
| PS1 | `online_order.received` | a paid web order's placement | Cashier chain | none | yes | 30 min |
| PS2 | `docket.web` | a web docket with items: placement, edit, zone | Kitchen chain | none | yes | 30 min |
| PS3 | `checkout.needs_attention` | a held checkout | managers | none | yes | 24 h |
| PS5 | `purchase.awaiting_approval` | a purchase created, or back to Pending | managers | `alertApprovals` | no | 72 h |
| PS6 | `waste.awaiting_approval` | a waste entry created, or back to Pending | managers | `alertApprovals` | no | 72 h |
| PS7 | `stock_request.new` | a stock request | Storekeeper chain | none | no | 8 h |
| PS8 | `stock.low` | a movement crossing below the minimum, queue only, once per item, location and Lagos day | Storekeeper chain | `alertLowStock` | no | 12 h |
| PS9 | `task.assigned` | a task created or reassigned, an automatic task (not the purchase review task while `alertApprovals` is on: PS5 covers it) | the assignee | none | no | 72 h |
| PS10 | `reservation.today` | a booking made or moved onto today, any channel | Reception chain | `alertArrivals` | no | until the booking |
| PS11 | `arrivals.digest` | the push sweep, 09:00–10:00 WAT, none at zero | every active Reception, else managers | `alertArrivals` | no | 12 h |
| PS12 | `table.still_occupied` | the push sweep, the Free Table Reminder's seatings, once per seating | Reception chain | none (the bell has none) | no | 1 h |
| PS13 | `orders.unsettled` | the push sweep, 09:00–10:00 WAT: bills left open from a previous day | managers and every active Cashier | `alertUnsettled` | no | 12 h |

A "chain" is D8's over that role. Lifetimes are clamped to between 60
seconds and 28 days (`MAX_PUSH_TTL_S`, the push services' cap). Waiter and
Bartender receive nothing, and the staff route's `events` list says so,
so the control tells them rather than offering a switch that never rings.
**Not pushed, by decision:** the welcome and the receipt (the customer is on
screen); Delivered, Collected and Received (the customer is part of it); a
booking the customer made, changed or cancelled themselves; a web order's
edit or zone change to the customer; a no-show (it would read as an
accusation); a held checkout to the customer (no order yet; CNC is
emailed and PS3 covers staff); a refused refund (every refusal happens
inside a staff request, and CNC handles no refund webhook; add it back if
one is ever handled); later online stage labels, task status changes and
low stock from an item's create or minimum to staff (the person made the
change); the cancel docket (it does not ring the bell either); per-bill
unsettled and per-booking arrival items at the Lagos midnight (the 09:00
digests instead: a push at midnight would wake people).

- **Push text never carries a phone number, an email address, a person's
  name, free text anyone typed, a payment reference, a money figure or an
  address.** It is shown on a lock screen to whoever holds the device.
  Allowed: order, KOT and PO numbers, table, room and stock-item names,
  dates, times and counts. PS9's words are constant, because a task's
  title is free text naming vendors and assets. Title at most 60
  characters and body 160 (`TITLE_MAX`, `BODY_MAX`), clipped with `…`;
  the columns are those widths. `push-catalogue.spec.ts` searches every
  event's text for `@`, `+234`, Nigerian mobile numbers, `₦`, `NGN` and
  `kobo`.
- **Customer links are `orderLink` or `RESERVATIONS_LINK`, the in-app
  list's own** (a site path without `/cnc`; the worker adds the base);
  **staff links are `/#<page>`**, with the bell's `ref` beside it for the
  hand-off, never shown. One builder per link means a push and the list
  item it mirrors cannot open different places.
- **The allowed push-service hosts** (`PUSH_SERVICE_HOSTS`): exactly
  `fcm.googleapis.com` (Chrome, Edge, Android) and
  `updates.push.services.mozilla.com` (Firefox); by suffix on a label
  boundary `.push.apple.com` (Safari; Apple asks allowlists to accept
  `*.push.apple.com`) and `.notify.windows.com` (Windows'
  `wns2-…` hosts). An endpoint must also be `https:`, on the default port,
  with no user name or password, and not an IP literal or `localhost`. A
  browser on a host missing here gets a visible 400 at subscribe ("This
  browser's notification service isn't supported."), never silence; each
  host is confirmed on staging with its browser. Adding a host is a code
  change with a test in `push-hosts.spec.ts`.

**The routes and the queue:**

- **`GET /me/push/public-key` and `GET /staff/push/public-key` answer the
  key (`no-store`), the staff one with the reader's `events` from the role
  on the account now, not the token; `POST` and `DELETE …/subscriptions`
  answer 204.** Every staff role may call them. Where push is not
  configured each answers 404 "Notifications are not set up on this
  service yet.", a subscribe included, so a client shows "unavailable"
  rather than storing a device nothing can reach. **No answer ever carries
  an endpoint, a key, `applicationServerKey`, a `dedupeKey` or a status**:
  an endpoint names a person's device.
- **A subscribe checks the keys' lengths (65 and 16 bytes) and the host
  (400), the server key (409, D12) and the live session (401, D4), then
  binds by endpoint: a new one is stored, the caller's own refreshed, and
  someone else's moved only when both keys match; otherwise nothing is
  written and the answer is still 204.** A genuinely shared device keeps
  its keys, and a stranger who learned an endpoint can neither take it
  nor learn whose it is. At most 10 devices a person
  (`MAX_PUSH_DEVICES_PER_OWNER`); the least recently seen go. A delete
  removes only the caller's own row. The limits are in *Rate limits*.
- **Delivery claims a row before sending it, by a conditional update of
  `attempts` that also leases it** (`retryAfter = now + PUSH_LEASE_MS`,
  60 s; a module-load check keeps the 30 s sweep budget below it), so a
  request and a sweep never both send it and a send never outlives its
  lease (each send's timeout is the deadline's remainder). Every device
  the person holds is tried at once: any delivered settles `SENT`; a
  retryable failure is `FAILED` with a wait of 1 then 5 minutes
  (`PUSH_RETRY_BACKOFF_MS`, through the backoff helper the mail queue
  shares), and `DROPPED` / `GAVE_UP` after the third attempt; devices
  `GONE` or `KEY_MISMATCH` are deleted, and a push left with none is
  `NO_DEVICE`; a 400 or 413, or a payload over 3 KB, is `REJECTED`. A push
  is short-lived news, so the waits are short. **While push is not
  configured a row waits `PENDING` and spends no attempt**, the mail
  queue's rule. Logs carry ids, counts, statuses and drop reasons only,
  never an endpoint, a key or a push's text.
- **Only `src/push/push-sender.ts` imports `web-push`, pinned at 3.6.7**
  (`@types/web-push` 3.6.4). 3.6.7 is the last CommonJS release; the next
  major is ESM-only, which this `nodenext` build and Jest cannot load. One
  importer keeps the library behind `PushSender`, which every e2e app
  replaces with `RecordingPushSender` (`test/recording-push-sender.ts`), so
  no suite reaches a push service.
- **`POST /internal/sweeps/push` (`PushSweepService`, every five minutes)
  runs three phases, each in its own try: the stale tables (PS12), the
  daily digests (PS11, PS13, only between 09:00 and 10:00 WAT), then the
  queue's sweep** (expire, then send what is due, oldest first, 100 a run,
  30 s at most). A failed phase is named in `failed` with its counts null,
  and the others still run, so a broken digest never stops delivery. One
  log line: `Push sweep: queued=<tables>/<digests> delivered=… held=…
  dropped=… failed=[…]`. Runs overlap the digests' hour and the dedupe
  keys make a repeat do nothing; a run missed for the whole hour sends no
  digest that day, and the bell still shows the items. Nothing depends on
  the sweep having run (*Auth*). Its Scheduler job is in *Infrastructure*.
- **An account deletion deletes the customer's devices and every push row
  to them, sent or not, explicitly** (`CustomerDeletionService`, beside the
  in-app list). The revocation would forget the devices and the waiting
  rows anyway; the deletion says so itself (Q36), and takes the sent rows
  too.
  Old rows and unused devices go with the retention sweep (*Data retention
  and account deletion*).
- **Tests:** `push-routes`, `push-queue`, `push-customer-events`,
  `push-staff-events` and `push-sweep` e2e suites, plus additions to
  `staff-people`, `staff-auth`, `customer-auth`, `account-deletion`,
  `retention` and `schema` (`PushMessage_one_recipient_check`: exactly one
  of `customerId` and `staffId`). Unit specs cover the catalogue (every
  role against every staff event, the privacy search), the sender's
  outcomes, the hosts and the window's edges. A test key pair comes from
  `test/vapid-test-pair.ts`, a real derived pair, which the boot check
  needs.

## Enquiries *(from C6)*

- **`POST /enquiries` (the Contact page) and `POST /group-enquiries` (the
  booking page's large-party callback) store an `Enquiry` and email it to
  `CNC_CONTACT_EMAIL`; there is no staff list** (Q20's default; plan §5.1,
  D50). The row is written and the email queued in one transaction, and
  sent after the commit: the enquiry is the thing of value, so a provider
  outage costs delivery time, never the person's message, and they are not
  told of CNC's mail trouble (204 either way). With no inbox configured
  (only possible locally; production refuses to boot) the row is kept and
  the log names its id, never its content.
- **Both answer 204 with no body, and a filled honeypot gets the same 204
  with nothing stored, sent or logged** (`company`, the forms' hidden
  field; TAY's rule). An error would tell a script which field to leave
  alone, and a log line would carry whatever it sent. The field is
  declared with `@Allow()` so the whitelist passes it to the service, and
  any value but absent, null or blank text counts as filled.
- **Two limits, apart, so defeating one does not defeat both**: at most 5
  stored enquiries per address an hour across both forms, counted on the
  rows (`ipHash`, the address hashed by `hashClientAddress`) under an
  advisory lock on the address, so a burst cannot slip past (seen failing
  without the lock); and 20 requests per address per form in fifteen
  minutes in memory (`EnquiryThrottle`), which also counts refused bodies
  and honeypot hits. Both are 429 "Too many attempts. Wait a few minutes
  and try again.". *From C8-3 the second count is stored, not in memory,
  and its 429 carries `Retry-After`.* Each accepted enquiry is an email into CNC's one inbox;
  a person writes once or twice.
- **The sentences are the website's where it has them**
  (`lib/enquiries.ts`): "Please add your name, your email and a message."
  (said once, whichever is missing), "Please add your name.", "Please add
  a phone number we can call you back on, for example 0803 123 4567.".
  The rest are new and marked so in `enquiry-messages.ts`. The callback's
  phone must be Nigerian and is stored as `0` plus 10 digits
  (`customerPhone`); its email is optional; its room is the slug, as
  `POST /reservations` names it; its date is today or later in Jos.
- **An enquiry's email may wait a week (`ENQUIRY_MAIL_TTL_MS`), not the
  queue's default day**: with no staff list the email is how CNC reads it,
  so a late one beats none.
- **No audit row**: an enquiry is not a command in the staff app's record.
  Q36's twelve-month retention of enquiries is C8-5's: *built*, see *Data
  retention* below.

## Online checkout and Paystack *(from C7)*

- **CNC's own Paystack account only: `CNC_PAYSTACK_SECRET_KEY`, read as
  `CncConfigService.paystackKey`, which treats unset, blank and
  `PLACEHOLDER_NOT_SET` as no key; while there is none, `POST /checkouts`
  and the webhook answer 503** (plan §8.1). The placeholder is public in
  `.env.example`: used as the webhook's signing secret it would let anyone
  sign a payment confirmation. **A deployed service outside production
  refuses to boot on an `sk_live_` key**, as production refuses anything
  else: staging's gate walks pay with test cards, and a live key there
  would charge real ones.
- **Every Paystack call goes through the `PaystackClient` interface
  (`PAYSTACK_CLIENT`, `src/payments/paystack-client.ts`), chosen by
  `CNC_ENV` (`paystackClientFor`): a local run gets `LocalPaystackClient`,
  which calls nobody; staging and production `HttpPaystackClient`; every
  e2e app `FakePaystackClient` (`fakePaystack(app)`).** No test and no
  local walk may open a transaction on CNC's merchant account, whatever
  key a `.env` holds (the mail transport's rule, for money). A local walk
  pays by signing a fake `charge.success` with its local key
  (`signPaystackBody`); the local client's verify answers it paid.
- **One exception, by the founder's request (2026-10-24): a local run with
  `CNC_PAYSTACK_LOCAL_MODE=test` gets `HttpPaystackClient`, against
  Paystack's test mode with CNC's test key** (`paystackLocalTestMode`).
  It is a choice made in the local `.env`, never a default. The boot
  refuses it without an `sk_test_` key, so a laptop can never charge a real
  card, and staging and production refuse the setting itself. Paystack
  cannot deliver a webhook to localhost, so the confirmation read's verify
  completes the order; the checkouts sweep does not run locally. Tests
  never use it: every e2e app binds the fake.
- **The HTTP client is TAY's: plain `fetch`, 10 s timeout, no retries,
  kobo never multiplied, never a body in a log line; unlike TAY's it
  narrows every answer at runtime (`readTransaction`) instead of casting.**
  A retry after a timeout cannot tell "never arrived" from "succeeded and
  the answer was lost" (verify can); a charge's body carries the card
  authorization; and a field Paystack sent in another shape must reach the
  amount check as absent, never as a guess.
- **The price is fixed by the server before Paystack is called: every
  line priced from the menu as it stands (`priceCart`), VAT on the
  subtotal rounded to the kobo, the zone's fee from Settings, total =
  subtotal + VAT + delivery (Q33: nothing for Paystack's charge), through
  the bill's own `orderTotals`** (`src/ordering/cart-pricing.ts`). A price
  from the browser is a price the customer chose. One function prices the
  quote and the checkout, so they never disagree. A dish that is not
  Available for Sale and Show Online is refused (the menu hides it, Q37);
  a choice must be one of the dish's options; two lines of one dish and
  option are one line, as on a bill.
- **A drink the Bar holds fewer of than the cart asks is a warning
  (`warnings`), never a refusal** (plan §7.4). The money comes first and
  stock never blocks a paid order; Q11 seeds no Bar stock, so on staging
  every drink warns until opening balances are entered.
- **The checkout judges its timing with `ordering-times.ts`, the
  functions `GET /ordering/slots` offers from (`judgeTiming`)**, so a
  time offered is a time accepted: as soon as possible only while
  `asapOpen`, a slot only today or tomorrow in Jos and only one of that
  day's `orderSlots`. The words stored (`timingText`) are the website's,
  with the lead read from Settings.
- **`POST /checkouts` runs in two steps: the idempotent transaction writes
  the `PENDING` checkout and draws no number; after it commits,
  `startPayment` calls Paystack's initialize and stores the access code and
  page on the row once (`accessCode IS NULL`).** A network call must not
  hold a transaction (the pool is 3), and the stored response of an
  Idempotency-Key cannot hold what happened after the commit, so a retry
  with the same key reads the page from the row. Paystack unreachable is
  503 and the checkout waits for the same key; Paystack refusing is 502 and
  the checkout is `FAILED`, so the page starts a new one with a new key.
  *From the C7 review:* **a refusal is judged by verify first
  (`afterRefusedStart`): a reference Paystack already holds (a same-key
  retry after an initialize whose answer was lost, or a racing request)
  leaves the checkout `PENDING` with a 503, or answers the page another
  request stored; only Paystack's definite "not found" closes it
  `FAILED`.** Paystack refuses a duplicate reference, so the retry the 503
  promises would otherwise close a checkout Paystack opened. The page
  cannot be recovered from verify, so such a checkout waits for the
  checkouts sweep (decided here; the plan does not cover a lost
  initialize answer).
  The order number is drawn only when the payment is confirmed (C7-3), so
  an abandoned checkout burns no `CNCR`.
- **A checkout lives 30 minutes (`CHECKOUT_TTL_MS`) before the checkouts
  sweep (C7-5) asks Paystack about it.** Long enough for a bank's one-time
  code and a second card; short enough that a timing chosen at checkout
  still means something.
- **`GET /checkouts/:reference` answers to the reference alone, and never
  carries the phone, email, note or account**, `no-store`. The reference
  is `cnc-order-<uuid>` (122 random bits, held to that shape by a CHECK),
  so knowing it is the capability the confirmation page needs; the name,
  address and timing are what that page shows. *From the C7 review:*
  **300 reads a minute per address (`CHECKOUT_READ_ADDRESS_LIMIT`)**,
  because a read may call Paystack's verify on CNC's merchant key, and a
  script cycling references must stop somewhere; a page polling every few
  seconds is far below it.
- **The webhook is `POST /payments/webhook` (plan §5.1, §8.6), TAY's
  receiver: HMAC-SHA512 over the raw body under CNC's key with
  `timingSafeEqual`, the `PaymentEvent` ledger keyed by the body's SHA-256
  (a replay of the same bytes changes nothing), the work after the answer
  with an in-flight drain (`WebhookDispatcherService.settled()` in
  tests), and a 120-a-minute ceiling per address.** Paystack retries a
  slow or non-2xx delivery, so the work cannot sit inside the request, and
  a 429 is a retry too, so the limit is a ceiling, not a budget.
  *Replaced in C8-3: the ceiling counts only deliveries with a bad
  signature, after the check; a correctly signed delivery is never
  counted or refused for volume (see* Rate limits*).*
  *From the C7 review:* **the request waits up to five seconds for its own
  handling (`dispatchWithin`, `WEBHOOK_INLINE_WAIT_MS`) and answers then
  whatever happens; slower work carries on after the answer.** Cloud Run's
  default request-based CPU allocation (staging deploys with
  `--min-instances 0` and no `--no-cpu-throttling`) starves work done
  outside a request, so a payment handled wholly after the answer could
  wait for the next request or the payments sweep. A verify and a settle
  normally take well under a second; the cap still keeps the answer far
  inside Paystack's retry time. Always-allocated CPU would also do it but
  costs money every hour an instance is up, which is the founder's call,
  not a code change.
- **Every `charge.success` is checked against Paystack's verify, always:
  success, the checkout's own reference, exactly its total, `NGN`; and the
  event's own amount and currency must agree too (`paymentMismatch`).** A
  mismatch holds the checkout `NEEDS_ATTENTION` with the reason, creates
  nothing else, and emails CNC's inbox (`checkout.needs-attention`, dedupe
  `checkout:<id>:attention`). TAY's webhook trusts the event; a signed
  event is still not proof of the amount a customer paid. Paystack's
  verify unreachable throws, so the delivery stays unprocessed for the
  payments sweep rather than being marked done.
- **A confirmed payment settles the checkout only from its settleable
  states (`PENDING`, `EXPIRED`, `FAILED`); `PAID` and `NEEDS_ATTENTION`
  are final for the webhook.** A late payment on an expired checkout is
  still money taken. *From C7-3 this replaces "one conditional update":*
  the settle locks the checkout's row (`SELECT … FOR UPDATE`), re-reads
  its status under the lock, writes the order, and then sets `PAID` and
  `orderId` in one update, because `Checkout_order_check` holds `PAID`
  and an order together and Postgres cannot defer a CHECK. Two reports of
  one payment (the webhook, the confirmation read, a sweep, two
  instances) then settle it once: the loser waits on the lock and finds
  it paid.
- **The card is stored as its brand and last four only (`cardBrand`
  "Visa", `cardLast4`), and the confirmation says "Visa ending 4081"**
  (plan §8.5). Nothing else of the authorization is kept.
- **A customer deleting their account (Q36) is refused while a checkout of
  theirs is `PENDING` or `NEEDS_ATTENTION`, and their other checkouts lose
  the name, phone, email, address lines and note** (a CHECK lets a phone
  be empty for this). Money may yet arrive on a waiting one, for an order
  nobody could then reach them about. *From the C7 review:* **an `EXPIRED`
  or `FAILED` checkout does not refuse the deletion, and a payment that
  later lands on a checkout whose contact the deletion wiped is held
  `NEEDS_ATTENTION` (`ANONYMISED_CHECKOUT_REASON`), never placed.** Both
  can still be paid (a transfer still settling, a page left open), and an
  order with no name, phone, email or address could be cooked but never
  delivered or refunded by word; refusing deletion for every abandoned
  checkout instead would block it for good, since those states are
  final.
- **A public route counted per address only uses `AddressThrottle(limit,
  ttl)` (`src/auth/auth-throttle.ts`)**: the bookings, the enquiries, the
  checkout (30 in fifteen minutes) and the webhook. One decorator names
  the three counts once, so a new route cannot forget to skip one.
  *From C8-3 the quote uses it too, the webhook does not (it counts its
  bad signatures by hand, after the check), and a signed-in customer's
  write uses its mirror, `CustomerWriteThrottle(limit, ttl)`.*

## Paid web orders and the payment sweeps *(from C7-3, C7-5)*

- **A paid web order is written by `OnlineOrderPlacementService.place`
  (`src/online-orders/`), only inside the settle transaction of
  `CheckoutPaymentsService`, with its audit row (`online.paid`, actor
  `SYSTEM` "Online checkout", reason "Paid online", ref the order
  number)** (plan §7.4 step 4). The order, its lines, the food docket, the
  `ONLINE` payment, the `OnlineOrder` and the Bar movements commit with the
  checkout's `PAID` or not at all; a paid checkout with no order would be
  money nobody cooks for.
- **The numbers (`CNCR-`, `WEB-`, `PAY-`) are drawn inside that
  transaction and nowhere earlier**, so an abandoned or expired checkout
  burns none (the C7 gate's step 5, checked against
  `order_restaurant_no_seq` in `test/online-orders.e2e-spec.ts`).
- **A web order is one `CNCR-` order, channel `WEB`, `SETTLED`, its lines
  carrying their own department (D29, D30), the checkout's VAT rate and no
  service charge; its `label` is the `WEB-` number and its `guest` the
  contact name.** The till's history tags `channel === 'WEB'` "Online"
  (`staff/components/cnc/pos.tsx`), and the reversal already refuses a
  non-POS bill.
- **The payment is the checkout's whole total (delivery included), the
  bill's `orderTotals` excludes the fee, and the fee is the online order's
  own `feeKobo`** (Q21: a separate line; Q33: nothing added for Paystack).
  The demo's `paid === totals(bill).total + fee` completion rule (C7-4)
  reads them that way.
- **The docket is revision 1 of the Restaurant lines only, written through
  `DocketsService.write` with the fulfilment, the scheduled time and the
  customer's note ("Note for the kitchen or rider"); a cart of drinks
  alone gets no docket and revision 0.** Drinks never go to the kitchen
  (§7.4), so the crosscheck never says "Mapping required" for them.
- **The drinks leave the Bar as `WEB_SALE` movements through
  `StockLedgerService.move` with `allowNegative`, one per paired stock
  item by the sum of its lines, in stock id order (`webSalePlan`); a drink
  with no paired stock item moves nothing and is logged as an error, never
  refused.** The money is taken (§7.4), so stock cannot block a paid order;
  the till refuses the same gap at settle because it can still say no.
- **Business dates and `settledAt` of a web order are the moment the
  payment is confirmed (Lagos), not Paystack's `paid_at`, which is kept on
  the checkout.** A payment confirmed after midnight would otherwise put a
  docket on a kitchen day already closed. *From the C7 review:* **the
  docket of a scheduled order is dated the Lagos day of its slot, never
  before the day paid (`webDocketDate`), for the first docket and every
  revision; the order, its payment and its sales stay on the day paid.**
  A docket for tomorrow's lunch dated today leaves the Kitchen bell when
  today's kitchen day closes, and tomorrow the cook's entry would count as
  a manager's correction; the money was taken today.
- **The order's customer is the signed-in one who placed it while live;
  else a verified customer by the checkout's email or phone, as a guest
  booking links (Q35); else, with "Save my details", the customer found or
  made by the email through `CustomerService.findOrCreateFromCheckout`,
  unverified, with no session (A15).** An existing account's details are
  never overwritten by a guest's form, and an unproved phone is saved only
  when no customer holds it. Signing in later with a code verifies that
  row, so the order is already in the account.
- **`GET /checkouts/:reference` rechecks a checkout whose payment page was
  opened and is still settleable (`CheckoutPaymentsService.recheck`), and
  never fails for it.** The customer lands there from Paystack, often
  before the webhook; whichever comes first writes the order. A recheck
  answers `unpaid` and changes nothing when verify does not say `success`
  (or Paystack does not know the reference); a reported payment
  (`confirm`, the webhook and the payments sweep) that verify does not
  confirm is held instead. *From the C7 review:* **at most one recheck per
  checkout every five seconds (`recheckedAt`, claimed by one conditional
  update, `RECHECK_INTERVAL_MS`), and an `EXPIRED` or `FAILED` one only
  for a day after its expiry (`RECHECK_AFTER_EXPIRY_MS`).** Each recheck
  is a verify on CNC's merchant key; a polling page or a looping script
  must not spend the rate limit the webhook's verifies need, and those two
  states are permanent, so without the window the read would ask
  forever.
- **`FakePaystackClient` verifies a transaction `abandoned` until the
  test `pay`s it; `postSignedWebhook` (`test/paystack-webhooks.ts`) pays
  before a `charge.success`.** Paystack sends that event only for a paid
  transaction, and a fake that answered every initialized reference as paid
  would let the confirmation read and the sweeps settle checkouts nobody
  paid. *From the C7 review:* **the fake (and `LocalPaystackClient`)
  refuses verify for a reference never initialized with a 400, as Paystack
  does, and `loseNextInitializeAnswer` opens a transaction and then loses
  the answer**, so the "not found" and the lost-answer paths are tested
  against the shapes Paystack sends.
- **The checkouts sweep (`POST /internal/sweeps/checkouts`,
  `PaymentSweepsService.sweepCheckouts`) rechecks `PENDING` checkouts past
  `expiresAt`, 50 a run, oldest first: paid ones get their order, wrongly
  paid ones are held, unpaid ones become `EXPIRED` by a conditional update
  on `PENDING`, and Paystack unreachable leaves them for the next run.** A
  checkout is never expired without asking Paystack, because a lost
  webhook must not turn money taken into an expired checkout. *From the
  C7 review:* **"unpaid" is a verify that answers anything but `success`,
  or Paystack's definite "not found" (a 4xx other than 401, 403 and 429,
  `paystackNeverSawIt`); a 5xx, a 429, a refused key or a malformed answer
  counts as unreachable.** `HttpPaystackClient` throws the same
  `PaystackRefusedError` for all of them, and an outage read as "never
  paid" would expire money taken, after which nothing rechecks it.
- **The payments sweep (`POST /internal/sweeps/payments`,
  `sweepPayments`) re-dispatches `PaymentEvent` rows unprocessed for five
  minutes (`UNPROCESSED_EVENT_AGE_MS`), 50 a run, by event and reference,
  through `WebhookDispatcherService.dispatch`.** No body is stored, so a
  `charge.success` is judged by verify alone, still as a reported payment.
  Five minutes, so a dispatch still in flight after its answer finishes
  first.
- **A deleted account (Q36) is refused while one of its online orders is
  `RECEIVED`, `PREPARING`, `ON_THE_WAY` or `READY`
  (`ACTIVE_ONLINE_STATUSES`); its other online orders lose the contact,
  address lines, display address and note, and its web bills their
  notes.** The kitchen and the rider still need a live order's details.
  The docket keeps its note: a docket revision is never changed.
- **`Checkout_order_check`: a checkout is `PAID` exactly when it has an
  order. `OnlineOrder` CHECKs: a fee never negative, pickup with no
  address, the contact as the checkout's, the number `WEB-` and 6+
  digits.**

## Staff Online Orders *(from C7-4)*

- **Every online command (`online.status`, `correctStatus`, `edit`,
  `cancel`, `zone`, `balance`) claims the `OnlineOrder`'s `version` first
  and then locks its bill (`FOR UPDATE`), in `OnlineOrdersService.claim`;
  its audit row's `ref` is the bill's `CNCR-` number** (the demo's
  `ref = w.orderRef`). One claim serialises every command on one order, so
  two devices settling one balance end as one payment and one stale 409
  (the e2e race asks Paystack once); the `CNCR-` ref puts the history
  under a reader `OrdersModule` already registers for the Cashier.
- **A paid web order is worth its bill's `orderTotals` total plus its
  `feeKobo`, nothing once cancelled (`onlineTargetKobo`, the demo's
  `target`); paid is the bill's non-reversed payments, refunds negative;
  the balance is worth less paid.** One function, so the list, the
  detail, the completion rule and `online.balance` agree to the kobo. The
  fee stays its own line outside the bill (Q21).
- **An order completes (Delivered or Collected) only at a balance of 0:
  "Record the outstanding payment or refund before completing this
  order."** The demo's rule. An edit, cancel or zone change that moves
  the order's worth leaves an `OnlineAdjustment` (+ due, − refund owed);
  `online.balance` settles every open one with its payment, and a change
  that brings the balance back to 0 settles them with no payment, so
  "open adjustments" and "balance ≠ 0" never disagree (plan §4.4: an
  order cannot complete while one is open).
- **The demo's one "Completed" is stored as `DELIVERED` for a delivery and
  `COLLECTED` for a pickup, and a status of the other mode is refused**
  ("Status does not match the delivery method." for a correction; the
  next-stage sentence for the Cashier). D31: the customer's labels need
  both words, and one stored value per stage keeps the two label maps
  honest.
- **Q8's default is enforced: `online.edit` and `online.cancel` refuse a
  completed or cancelled order with the demo's "Select an active online
  order."; there is no customer cancel.** The demo let a manager change a
  completed order; Q8's default stops at Completed. `correctStatus` can
  still reopen a completed order to an earlier stage, as the demo's test
  does, and then it can be edited.
- **`online.edit` takes Restaurant and Bar lines (D30), refused with "Choose
  a Restaurant or Bar menu item." (the demo's sentence with the Bar
  added); a dish already on the order keeps the name and price it was
  paid at, a new one takes today's; a dish off sale may stay only if the
  order holds it.** Plan §4.1: a price change applies to new lines only.
  The duplicate check keys a line by dish and option (`LineRules.lineKey`),
  as the demo's `positiveLines` does. *From the C7 review:* **"already on
  the order" is the line, dish and option: another option of a dish the
  order holds is a new line at today's price, and a dish off sale may
  stay only in an option the order holds.** The demo matched the paid
  price by dish alone; plan §4.1 ("a price change applies to new lines
  only") and the bill's own line key (`replaceLines`, the `OrderLine`
  unique key) make it a new line, and the plan wins over the demo.
- **Only the fields an edit sends change: a blank name or phone keeps the
  one held (the demo's `c.name?.trim() || w.name`), and the note changes
  only when sent.** The demo blanked the note and the address when the
  form left them out; the address belongs to `online.zone` (Delivery
  Details), whose structured address the checkout's sentences judge.
- **An edit moves the drinks' Bar stock by the difference and a cancel
  returns them all (`barDifference`), through `StockLedgerService.move`
  with `allowNegative`: more served is `WEB_SALE`, fewer is the new
  `WEB_SALE_RETURN`.** D30. The paid order took its drinks without
  refusing (§7.4), so a correction of it must not be refused for stock
  either; a separate return type keeps the Bar's history readable. *From
  the C7 review:* **a return is never more than the order's own
  `WEB_SALE` less `WEB_SALE_RETURN` movements took from that stock item
  (by ref = the `CNCR-` number; `heldToTaken`), and a cancel returns
  exactly what they took.** The difference is worked out from today's
  pairing of drinks to stock items; a drink paired only after it was sold
  would otherwise be "returned" to a Bar it never left. A drink paired at
  the sale and re-paired since is still returned in full by a cancel; an
  edit of it while it has no pairing moves nothing and is logged, as at
  the sale.
- **An edit writes a new docket revision (Restaurant lines only) when the
  food or the note changed; a cancel writes an empty cancellation
  revision when the kitchen had food; a zone change between delivery and
  pickup reprints the food with the new fulfilment.** The kitchen's paper
  must match the order; a drinks-only change gives the kitchen nothing
  to print.
- **A cancelled web bill is `CANCELLED` with `settledAt` cleared and keeps
  its lines; the money owed back is the balance, returned by
  `online.balance`.** `Order_settled_check` ties `settledAt` to `SETTLED`.
  The lines are the record of what was cancelled; the demo emptied them.
- **Q27: a zone change prices the new mode from the fees the order
  snapshotted at checkout (`Checkout` and `OnlineOrder`
  `deliveryJosKobo`/`deliveryOutsideKobo`), never from Settings now, and
  only before dispatch (Received or Preparing).** "Recompute from the
  fees snapshotted on the order": the order snapshotted only its own
  zone's fee before C7-4, so both are now copied at checkout. A fee the
  Owner changes later never reaches a paid order.
- **Edit, cancel and zone are checked by `withinLimit` on the difference
  they make (`LIMITED_DECISIONS.onlineChange`) and counted toward the
  day; `online.balance` is checked on the balance it records
  (`paymentCorrection`) and counted too.** The demo counts both (plan
  §6.2: edit, cancel, balance: L, D; zone per Q27's "under the limits").
  So a refund decided by an edit and paid by a balance counts twice
  toward one manager's day, as in the demo; the Owner is never counted.
  *From C8-0:* a card refund Paystack refused releases only its own
  `online.balance` row, never the edit's or the cancel's: the change to the
  order was a real decision and still stands; only the money that never
  moved is given back.
- **`online.balance` records the whole balance in one payment, as the
  demo does: extra money due is `CASH` or `TRANSFER` only (Q34); a refund
  is `CASH`, `TRANSFER` or `PAYSTACK` (Q26), and a card refund is never
  more than the card's `ONLINE` money not yet refunded.** Q34's default
  has no payment link and the demo's Card is not offered (Q34 names Cash
  or Transfer). Paystack refunds a transaction only up to its amount, and
  cash taken later cannot go back to a card. *From the C7 review:* **a
  `PAYSTACK` refund owed beyond the card's money sends the card's part and
  leaves the rest owed (`recordedBalanceKobo`), for a Cash or Transfer
  `online.balance`; the adjustments are settled only by the payment that
  brings the balance to 0, and the limits judge what each payment
  records.** Q26 sends refunds through Paystack as far as Paystack can
  take them, and "Record the rest as Cash or Transfer." (still the 409
  once nothing is left on the card) must be something staff can do.
  **The checks run in the demo's order: the order (404 or stale), "No
  payment adjustment is outstanding.", the card's own sentences (new),
  the limits, then "Transfers require a sender/recipient and
  reference."** The screen shows the sentence the API sends, so the order
  is the demo's.
- **A card refund is recorded in the idempotent transaction (a negative
  `ONLINE` payment and a `PENDING` `OnlineRefund`, the limits and ledger
  included) and sent to Paystack after it commits, by the one request
  that moves it `PENDING` → `SENDING` (`OnlineRefundsService.send`).**
  A network call must not hold a transaction (the pool is 3), and the
  conditional claim makes a retry of the same key replay the record
  without sending twice.
- **Paystack refused is `REFUSED` (502): the refund's payment is reversed
  and its adjustments open again, so the refund is owed once more and a
  manager records it as Cash or Transfer. No answer is `UNCONFIRMED`
  (503): the payment stays recorded and nothing resends it.** A refusal
  means no money moved; a lost answer may mean Paystack queued it, and a
  second send could pay the customer twice. A 5xx or a malformed success
  from Paystack's refund API counts as no answer, never as a refusal. The
  ledger row of a refused refund stays (append-only); *from C8-0* a
  release row beside it gives back what it counted (see *Money controls*),
  so the Cash or Transfer that pays the refund counts once. *From the C7
  review:* **a manager resolves an `UNCONFIRMED` refund, or one left
  `SENDING` for over two minutes (`REFUND_SENDING_STUCK_MS`), by what
  Paystack's dashboard shows: `POST /staff/online-orders/:id/refunds/
  :refundId/resolve` (M+r, the order's `version`, audited
  `online.resolveRefund`). `SENT` with the dashboard's refund id is
  accepted as Paystack's answer would be (the customer is told); `NOT_SENT`
  is undone as a refusal is, so the refund is owed again.** *From C8-0:*
  **an `UNCONFIRMED` refund keeps counting toward the Daily Approval Limit
  until it is resolved; `SENT` keeps counting (the money moved); `NOT_SENT`
  releases the count on the deciding manager's original business date,
  whoever resolves it and on whatever day. Undoing a refund is one
  conditional move out of the status the caller read (`SENDING` for
  Paystack's refusal, the read status for a resolve), so a refusal and a
  "not sent" arriving together undo and release once; a resolve that loses
  is 409 "Only a card refund Paystack has not confirmed can be resolved."
  (`REFUND_NOT_UNCONFIRMED_MESSAGE`).** Without the condition the second
  would reverse the payment again and release twice. Without it an
  unanswered refund left the balance at 0 and no way to record the money
  if Paystack never had it. Two minutes is far past the client's
  10-second timeout, so a send still waiting is never resolved under it.
- **CNC absorbs Paystack's fee on a refund (Q26): the refund is exactly
  the money owed, nothing added or taken off.** Q26's default.
- **A card refund needs CNC's Paystack key: with none, `PAYSTACK` is 503
  "Card refunds are not available just now. Record the refund as Cash or
  Transfer." before anything is recorded.** Without a key the HTTP client
  cannot send it, and a refund recorded and never sent would read as
  unconfirmed money.
- **The Paystack client lives in `PaystackClientModule`, which
  `PaymentsModule` re-exports and `OnlineOrdersModule` imports.**
  `PaymentsModule` imports `OnlineOrdersModule` for the web order a
  payment writes, so the refunds could not import `PaymentsModule` back.
- **Online Orders' list tab travels as `ACTIVE` or `HISTORY`** (plan
  §5.4 writes `tab=active|history`; *Contract conventions*: enums travel
  `UPPER_SNAKE`). Active is `ACTIVE_ONLINE_STATUSES`, which account
  deletion (Q36) shares from `online-order-rules.ts`.

## Order messages, my orders and the online bell items *(from C7-6, C7-7)*

- **Every message about a web order goes through `OnlineOrderMail`
  (`src/online-orders/online-order-mail.ts`): an email to the address
  given at checkout and, when the order belongs to a customer, an item in
  their in-app list, both queued in the event's own transaction under one
  dedupe key and sent after the commit.** The *Mail* and *in-app list*
  rules, applied to orders: a failed send never fails the payment or the
  staff command, and a replay writes nothing twice.
- **The receipt is queued by `OnlineOrderPlacementService.place`, inside
  the settle transaction, and always emailed (Q31's default), whatever
  Order Updates says** (`online:<id>:receipt`, kept a week). A payment
  that commits then always has its receipt, whoever confirmed it (the
  webhook, the confirmation read, a sweep), and the four reports of one
  payment send it once. Its words and layout are the website's done
  screen ("Thank you, Ada.", "Your order is in.", the lines, "Total
  paid"), money through `formatKobo`, the zone's label from
  `ZONE_LABELS` (the website's).
- **Every stage change writes the in-app item; the email goes for on its
  way and ready only while the customer keeps Order Updates on, and for
  a cancellation always (`statusMailKind`, `sendsStatusMail`).** Q31's
  default and the switch's new words, "When your order is on its way or
  ready". A cancellation is about the money the customer paid, as a
  booking's cancellation is always sent. Preparing, delivered and
  collected send no email: the customer has nothing to do about them.
  **A guest's order (no customer) gets the on-its-way and ready emails**,
  as a guest's booking gets its reminder (Q32): the guest gave the email
  for this order and has no switch. The key carries the version the
  command claimed (`online:<id>:status:<version>`), so two changes are two
  messages; a command that leaves the stage as it was sends nothing. On
  its way and ready expire after three hours
  (`ORDER_PROGRESS_MAIL_TTL_MS`): later, the food has arrived and the
  email would only mislead.
- **A refund is told when the money has gone back, always, by email and
  in the app: Cash or Transfer in `online.balance`'s transaction, a card
  refund in the transaction that records Paystack's acceptance (`SENT`),
  never for one refused or unconfirmed** (`online:<id>:refund:<payment
  id>`, kept a week). A notice for a refund Paystack then refused would
  tell the customer money is coming that is not. Extra money taken in
  person (Q34) sends nothing. An edit or a zone change sends nothing by
  itself; the refund notice that settles it says what came back.
- **Deleting an account (Q36) forgets its orders' messages too
  (`online:<id>:` prefixes in `OutboundMessagesService.forget`)**, as its
  bookings' and checkouts' are: a sent receipt's `to` beside an order id
  would name the person an anonymised order belonged to.
- **`GET /me/orders` and `GET /me/orders/:number` read the orders linked
  to the customer (`OnlineOrder.customerId`), newest first, as they now
  stand: the stored stage, the bill's lines and `orderTotals`, the fee as
  delivery, and the card that paid** (plan §5.2; `no-store`). The tracker
  polls the stored stage (C7-9), never a clock. `:number` is the `CNCR-`
  number, the one the confirmation page shows and `/account#order/<n>`
  names. Another customer's order, or none, is 404 with the account app's
  "We could not find that order on this account.", so the route cannot
  tell whether another customer's order exists.
- **The bell's online items are computed on read in
  `StaffNotificationsService`, before the reception items as the demo
  orders them, with their words in `online-bell-items.ts`:** the
  Cashier's active online orders ("Online Order · Paid", the demo's item,
  plan §9.1: the Cashier only); the Kitchen's and managers' "New Web
  Docket" (a web docket whose revision is the bill's current one, with
  items, no kitchen entry under its ref, on a kitchen day not closed); the
  managers' "Checkout Needs Attention" (every `NEEDS_ATTENTION`
  checkout). A closed day takes no more entries, so without that test its
  dockets would ring forever; a cancellation docket has no items and
  rings nothing.
- **A bell item may carry `ref`, the record its page opens on: the New
  Web Docket its `KOT-` ref, and (from the C7 review) Checkout Needs
  Attention its checkout's id** (plan §9.1: "kitchen, with the ref filled
  in"). The id alone would make the staff app parse ids.
- **A held checkout stays on the managers' bell until a manager resolves
  it: `POST /staff/online-orders/checkouts/:checkoutId/resolve` (M+r, 204,
  audited `online.resolveCheckout` under the checkout's reference) moves
  `NEEDS_ATTENTION` to the new final `RESOLVED` by one conditional update
  (`Checkout_resolved_check` ties it to `resolvedAt`).** *Replaces "and
  nothing does yet" (C7 review).* The money is sorted out in Paystack's
  dashboard; without a way out, the item rang forever and its customer
  could never delete their account (Q36). No order is made: a held
  payment never becomes one without a person. A new state rather than
  `FAILED`, because `FAILED` is settleable and a replayed report would
  hold it again.

## Load testing *(from C8-4)*

- **`npm run load:till` (`scripts/load/till-and-booking.ts`) is plain
  Node: `fetch` (undici, in Node 22) and `pg` for the connection sampler,
  so it adds no package.** A load tool pinned for one card is a dependency
  to keep current for nothing else. How to run it, and the founder's steps
  for staging, are in `docs/load-testing.md`.
- **It runs only against a backend started locally on a throwaway
  database, created and dropped for the run, or against CNC staging by the
  founder with TAY idle** (plan §19, risk 1: the shared db-f1-micro allows
  about 25 connections and TAY alone can open 40). Never against
  `cnc_db` or `cnc_test`, whose rows other work reads; never against
  production. The connection sampler (`CNC_LOAD_DB_URL`) refuses anything
  but a local database (`databaseTarget`).
- **The script enforces where it runs (`scripts/load/load-targets.ts`,
  C8 review):** every base URL must be `localhost`, `127.0.0.1` or
  `[::1]`, or exactly `https://api-cnc-staging.tayxcnc.com` with
  `CNC_LOAD_CONFIRM_STAGING` set to that host; any other host is refused
  before a request is sent, and `CNC_LOAD_SPOOF_ADDRESSES` is refused with
  a staging origin. A host copied from the docs and edited by mistake, with
  an Owner's password in the shell, would otherwise create staff accounts
  and settle cash bills that, as money records, are never deleted.
- **A refused or failed step waits for `Retry-After` (2 s on the busy
  database's 503, a 429's window), or a second, before the next
  (`backoffMs`); the summary counts the waits.** Retrying at once would
  multiply the load on the shared instance at the moment it is slowing,
  the moment the founder is watching its connections.
- **The load test sends no email anywhere.** Its guests are
  `@example.com`, which the outbound queue gives up unsent on Resend
  (*Mail and the outbound queue*), and locally the recording transport
  sends nothing; so the local figures include no mail send, and neither
  will staging's.
- **The mix is the venue's busy hour, compressed:** cashiers opening,
  filling, sending and settling Restaurant bills in cash; Reception reading
  the floor, booking and reading the day; website guests reading
  availability and booking; managers and cashiers polling the bell, the
  overview and Online Orders. Restaurant dishes only, because a Bar sale is
  refused without Bar stock and a load test must not count stock. Bookings
  are 400 days or more ahead, one table and date each, cancelled at the
  end; bills stay, because money records are never deleted.
- **It reports how long the load generator itself was paused** (a 100 ms
  timer's lateness). On the founder's 8 GB machine a run was seen paused
  for 15.9 s by memory pressure, and every timing and error in such a
  window is the machine's, not the server's. A run whose pause is more
  than a second is read with that in mind.
- **Measured locally (2026-10-24, two instances on one throwaway database,
  Postgres 16 on the same machine).** The default mix (4 cashiers, 1
  receptionist, 2 website guests, 4 pollers every second, 60 s): 42,120
  requests, 691 a second, p50 9 ms, p95 23 ms, p99 38 ms, no errors, the
  generator never paused; the database held at most 6 client connections,
  exactly the pools' 3 × 2. A heavier mix (8, 2, 4 and 8 pollers every
  half second) during a 15.9 s machine stall: 514 a second, p50 17 ms,
  p95 65 ms, p99 121 ms, 13 errors all inside the stall, 6 connections at
  most. The errors were transaction and pool timeouts answered 500: the
  defect fixed in *Errors* (now 503 with `Retry-After`). The default mix
  again after the fix: 37,597 requests, 617 a second, p50 9 ms, p95 27 ms,
  p99 53 ms, no errors, 6 connections at most.
- **The pool cap holds under load: CNC never exceeded 3 connections an
  instance.** Each instance held its three open for the whole run (the
  pool keeps an idle one 300 s), and a fourth concurrent query waits in
  the pool (up to 5 s, then 503) rather than opening a connection the
  shared instance does not have. The overview poll is the slowest read (p50 88 ms with the day's
  3,600 test bills). *Correction (C8 review):* that run's database held
  one seeded month, so it could not show that the settled bills read
  scanned every settled bill in history, growing with every day, not
  only with the day's bills; `Order(status, settledAt)` now bounds it to
  the range's bills, and the crosscheck count is bounded to a year
  (*The overview*). The load test was not rerun after the index; the
  query alone was measured on a year of history.
- **Not measured: CNC staging.** Cloud Run, the Cloud SQL proxy and the
  shared db-f1-micro (with TAY idle) are the founder's run.

## The acceptance list *(from C8-6)*

- **`test/c8-acceptance.e2e-spec.ts` runs the Backend Brief's §12 list,
  one test per line in the brief's order, on its own database with the
  real seeds**, with the plan's two restatements: line 1 holds
  `docs/demo-tests-map.md` to the specs (107 rows, the suites' counts,
  every named spec present and every mapped title opening a plain `it(`
  or `test(` call, or an `.each(…)(` one, and no spec under `src`,
  `test`, `scripts` or `prisma` skipped, left to do or focused; C8
  review: a title found anywhere in the file passed for a skipped test or
  a comment, and Jest reports a skip without failing), and line 3 compares the
  public menu, ordering config and quote with the staff menu and settings
  through the API. A test per line makes a failure name the promise that
  broke.
- **The 107 demo tests are 97 backend tests and 10 browser-only ones**
  (`docs/demo-tests-map.md`): those ten have no server counterpart. Four
  (one screen choice and the three file tests) stay in the staff app's own
  suite; six of the demo's browser storage are marked `retired with the
  demo store (C8-5)`, because the staff app removed that store and its
  tests (C8 review: the map still called them the staff app's, and line 1
  skipped them unchecked, so it passed while six rows named tests that no
  longer exist anywhere). Line 1 counts both kinds exactly. Where a demo
  test's assertions are split over several backend tests, the map lists
  each; no demo test needed a new port in C8-6. The bell's two rows
  (`attendance.test.cjs`) are held by the approvals test, which drives the
  waste and purchase approvals through their routes and reads the
  manager's Approval items 2, 1, 0, and by the staff bell's exact per-role
  bells (C8 review: the map first named tests that read only the
  approvals screen).
- **"No API response contains card numbers, sign-in codes or other
  customers' data" is tested by calling every route in the published
  OpenAPI document as two signed-in customers, every staff role and an
  anonymous caller: every GET with the walk's real ids, every write with
  an empty body, plus every response the walk received.** Searched for: a
  13 to 19 digit Luhn-valid run (not a decimal's digits), every sign-in
  code mailed, every stored code, password and refresh-token hash and any
  `*Hash` field, every refresh token set in a cookie, the other customer's
  id, email, phone and street, and either customer's contact in any
  response to the Waiter, Bartender, Kitchen, Storekeeper or nobody (plan
  §6.1 gives those roles no page with a customer's contact; Reception, the
  Cashier and managers read them by design). The search is proved by
  planting each kind once. Writes that end the caller's session or account
  are left out of the sweep; their suites prove them.
- **A checkout's reference is the confirmation page's capability**: each
  customer reads only their own in the sweep, and a guessed reference
  finds nothing. The reference is 122 random bits (*Online checkout*), so
  holding it is what lets the page show the name and address.

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
  On staging only `CNC_PAYSTACK_SECRET_KEY` (until the founder stores CNC's
  test key, Q18), `CNC_RESEND_API_KEY` and `CNC_MAIL_FROM` (until C6) may
  hold it; every other secret is real from the start. *Corrected in C8-5:
  this said "until C7"; the payment routes shipped in C7 and answer 503
  while the key is the placeholder.*
- **Secrets are created with `printf`, never `echo`** (see *Local
  environment*).
- **The Artifact Registry repository `tayxcnc-cnc` must exist before the
  first deploy.** Enabling the API does not create it.
- **Nothing in the media bucket is public; the stored value is the
  `gs://bucket/object` URI, and a fresh V4 signed URL is minted per read**
  (A17). A stored signed URL expires and becomes a link that worked once.
  Signing needs `serviceAccountTokenCreator` on the runtime account, granted
  to itself: without it uploads succeed and every download fails.
- **Every photo goes through `PhotoStore` (`src/images/`), and only
  `ImagesModule` imports `StorageModule`.** One door into the bucket, and
  one place for the rules (A17): the file is judged by its bytes, never its
  name or declared type; it is resized (staff 320 pixels square, menu inside
  800) with every piece of metadata, GPS position included, removed; it is
  stored under a fresh random name; and a response signs it through
  `signedUrlOrNull`, which answers null rather than failing when signing
  fails.
- **A photo is uploaded before the command's transaction opens, the old
  object is removed after the commit, and a command that fails removes the
  new one.** An upload is a network call no transaction should hold a row
  lock across; deleting the old object first and then failing would leave
  a row pointing at nothing, while this order's worst case is an orphaned
  object nobody references.
- **The bucket sits behind `MediaStorage` (`src/storage/media-storage.ts`),
  bound to `GcsMediaStorage` in the service and to `FakeMediaStorage` in
  every e2e app by `createTestApp`.** No test writes to a real bucket or
  needs Google credentials, and a suite can read back the exact bytes that
  were stored. The Google client is made on first use, so booting and the
  health checks never depend on credentials.
- **Cloud Scheduler jobs send `Content-Length=0` and are created with
  `--format="value(name)"`** (plan §11), so the job works against Cloud Run
  and the sweep token is never printed.
- **Each `cnc-staging-sweep-*` job is created in the card that adds its
  route, not before.** A job pointed at a route that does not exist yet
  fails on every run, and a scheduler log full of expected 404s hides the
  failure that matters.
- **The sweep jobs, all `POST`, `Africa/Lagos`, `europe-west1`, header
  `x-sweep-token` from `CNC_SWEEP_TOKEN` plus `Content-Length=0`, URI
  `https://api-cnc-staging.tayxcnc.com/api/v1/internal/sweeps/<name>`**
  (plan §5.5). Production has the same jobs with `cnc-prod-` names when
  C9 provisions it.

  | Job | Schedule | Route | Card | Why this often |
  | :--- | :--- | :--- | :--- | :--- |
  | `cnc-staging-sweep-tokens` | `0 3 * * *` | `tokens` | C3-9 (exists) | housekeeping; nothing reads expired rows |
  | `cnc-staging-sweep-messages` | `*/5 * * * *` | `messages` | C6-8 | a sign-in code lives 10 minutes, so a queued one must go within minutes; the backoff (5, then 30) is counted in these runs |
  | `cnc-staging-sweep-reminders` | `*/15 * * * *` | `reminders` | C6-8 | a reminder goes at most 15 minutes after its 24-hour mark |
  | `cnc-staging-sweep-checkouts` | `*/10 * * * *` | `checkouts` | C7-5 | plan §5.5; a checkout lives 30 minutes, so an abandoned one is expired, or a paid one whose webhook was lost gets its order, within 40 |
  | `cnc-staging-sweep-payments` | `*/15 * * * *` | `payments` | C7-5 | plan §5.5; a delivery is handled within seconds, so one still unprocessed after 5 minutes failed, and 15 bounds how long a paid order can wait on a verify outage |
  | `cnc-staging-sweep-retention` | `30 3 * * 0` | `retention` | C8-5 (exists, 2026-10-25, on the founder's go-ahead) | Q36: periods counted in months and years; weekly, by the founder's choice (2026-10-25), so a record goes at most a week after its date, well inside "after 12 months" and "after 2 years"; one run's cap (10,000 rows a table) is years of CNC's enquiries and shifts; Sunday 03:30, after the tokens sweep and far from service, so its deletes never meet the till's pool |
  | `cnc-staging-sweep-push` | `*/5 * * * *` | `push` | C10 | a held push goes within 5 minutes of the staff window opening, a failed one soon after its 1- or 5-minute wait, and PS8 and PC9 (queued only) within 5 minutes; the 09:00–10:00 digests get twelve chances; the messages job already wakes the service this often |

  The two C7 jobs are created after the C7 deploy is live, as the C6 ones
  were. The retention job was created only on the founder's go-ahead, after
  the C8 deploy was live: it deletes personal data, and no code depends on
  it having run. Its cost is nil in practice: the messages job already
  wakes the service every 5 minutes. **The prod job must exist before the site's account page
  reaches production**: its privacy note (cnc-frontend
  `components/account/panels.tsx`, Q36) tells customers enquiries are
  deleted from CNC's records after 12 months, and only this job deletes
  them (C8 review).

  The push job is created after the C10 deploy is live, as the others
  were, then forced once; its log line is `Push sweep: … failed=[]`.
  Staging's deploy refuses to start until the three `CNC_VAPID_*`
  secrets exist and the runtime account is granted each (*Configuration*),
  so they are created before the merge that mounts them. In production it
  is `cnc-prod-sweep-push`, against `api-cnc.tayxcnc.com`.

  Create the two C6 jobs **after the C6 deploy is live** (the rule
  above), each with `gcloud scheduler jobs create http <job> --location
  europe-west1 --project tayxcnc-staging --schedule "<schedule>"
  --time-zone "Africa/Lagos" --uri "<uri>" --http-method POST --headers
  "x-sweep-token=<value>,Content-Length=0" --format="value(name)"`, the
  token read from Secret Manager into a shell variable, never typed or
  printed. Then force one run of each and read its one log line ("Sweep
  messages sent …", "Sweep reminders reminded …"). A `POST` without
  `Content-Length` is refused by Google's front end with 411 before it
  reaches the guard (TAY's runbook).
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
- **An e2e suite that saves the one-row tables (`Settings`, `Business`) or
  the opening hours through their routes holds `lockSharedRows`
  (`test/shared-rows-lock.ts`) for the whole suite and puts back every
  value it changed in `afterAll`; the seed suite holds the same lock while
  it asserts on those rows.** Those writes commit and every suite shares
  the rows, so without the lock a parallel run shows the seed suite a
  version it did not move. Such a suite never changes the approval limits,
  which other suites read live.
- **An e2e suite never edits a seeded menu item, category or stock item;
  it makes run-unique ones of its own.** The seed suite holds the seeded
  menu to its sources field by field, and a fresh CI database may not have
  been seeded when the suite runs.
- **A suite that must own the whole database (one Owner only, the first
  Owner's temporary password, assertions over every audit row) runs on
  `createIsolatedDatabase` (`test/isolated-database.ts`), seeds it with the
  real seeds, and drops it in `afterAll`.** The shared test database always
  holds other suites' Owners and rows, and committing the changes such a
  test needs there would break the suites running beside it. The helper
  creates the database on the `CNC_DB_URL` server only when that is a local
  development database by `databaseTarget`, applies the committed
  migrations' SQL in order, and removes leftovers older than six hours. On
  its own database a suite may edit seeded rows; the rule above is about
  the shared one. The C3 gate walk and the ported staff app specs use it.
- **Suites that sign staff in through the routes share
  `test/staff-sessions.ts` (`clientAddress`, the refresh cookie readers).**
  The cookie name and the address shape are then written once.
- **`openapi-cnc.json` is written by the app when it boots outside
  production, and by nothing else.** It is gitignored. To refresh it after a
  contract change, start the app once and stop it when the log says the spec
  was written. Never edit it by hand: `npm run mock` and the frontends read it
  as what the controllers say.
- **An isolated test database is dropped by ending this role's own sessions
  on it and then a plain `DROP DATABASE`, never `WITH (FORCE)`** (from C4,
  `test/isolated-database.ts`). On Postgres 16, FORCE refuses the whole drop
  with "permission denied to terminate process" when an autovacuum worker is
  visiting the database, because the worker carries no role the test user
  may signal; a freshly seeded database invites one, and the suite then
  fails after all its tests passed. A plain drop stops autovacuum workers
  itself.
- **A test that counts every Owner (or any rows other suites create) inside
  a rolled-back transaction runs it at REPEATABLE READ** (from C4: the seed
  suite's first-Owner tests and the money-control last-Owner tests). Suites
  run in parallel and commit Owner accounts of their own; under READ
  COMMITTED one committed after the test demoted every Owner was counted,
  and the test failed intermittently. Tests that must see another
  transaction's commit after a lock (the approval ledger races) stay READ
  COMMITTED.
- **A suite that needs a later time fakes `Date` and nothing else:
  `jest.useFakeTimers({ now, advanceTimers: true, doNotFake: [...every
  timer...] })`, then `jest.setSystemTime` only forwards, with fresh access
  tokens after each jump** (from C4: `test/c4-gate.e2e-spec.ts`,
  `test/c4-demo-ports.e2e-spec.ts`). The server reads the time through
  `new Date()` in the same process, so it sees the test's clock with no
  clock injected into production code. Faking any timer would stall the
  pool, the HTTP server and Postgres I/O. Moving backwards would let a row
  stamped by Postgres's own `now()` sort before one written earlier. An
  access token lives 15 minutes, so one minted before a jump of hours is
  already expired after it. Such a suite runs on `createIsolatedDatabase`:
  the bills it dates on another day must not meet another suite's.
- **The C4 gate walk (`test/c4-gate.e2e-spec.ts`) is one test per gate
  step, in the plan's order, sharing state; the cross-command races live in
  `test/c4-races.e2e-spec.ts`** (from C4). Both seed their own database
  with the real seeds (`seedData`), so the gate uses the venue's own Diner
  B1, Lounge TS1 and a real dish with a choice, and every balance a race
  asserts is that suite's alone. One test per step makes a failure name
  the step the founder will walk. Each command suite keeps its own single
  race. The races suite repeats the acceptance races over several rows
  and adds those across commands (a booking against a walk-in, settles
  against issues on one balance), because a race that passes once can still
  lose one time in five.
- **The C5 gate walk (`test/c5-gate.e2e-spec.ts`) follows the C4 walk's
  form: one test per step, in order, on its own database with the real
  seeds and a clock faked from the next noon in Jos** (from C5). It buys
  its stock through a requisition and moves it through the Store, because
  Q11 seeds no Kitchen stock and the gate is the founder's walk of the
  real path; the noon start keeps every approval on one business date, so
  the daily limit in step 6 cannot reset mid-walk. The C5 approval races
  are in `test/approvals.e2e-spec.ts`: two Managers approving the same
  requisition or entry, and an approval racing a rejection, each over
  several rounds, asserting that the day's ledger counts only a winning
  approval.
- **The C6 gate walk (`test/c6-gate.e2e-spec.ts`) follows the same form,
  and walks only the backend's half of each step** (from C6). The pages
  under `/cnc`, the real inbox and the Resend delivery are the founder's
  walk on staging; here "the email arrives" means the recording transport
  was handed it and its `OutboundMessage` row is `SENT`, because no test may
  reach a real mail provider. The walk's own `CNC_CONTACT_EMAIL` is set at
  the top of the file, as the enquiries suite does, so step 7 does not
  depend on a developer's `.env`. Step 2's website booking is a guest
  booking under the signed-in customer's email, so the walk also proves the
  A15 link the site's done screen promises; step 4 frees the table the way
  Reception does on the night (check in, then release), not by cancelling,
  because releasing is the path that ends a seating and completes the
  booking (plan §7.5). Step 5 books a second table from the app and moves
  the clock to 23 hours before it, refreshing the session there as the app
  would, so the refusal is judged on the server's clock (A11). The
  sentence is asserted as a literal string as well as the constant, so a
  change to the constant that broke the app's wording fails the gate.
- **Every C4 race test was seen failing with its guard removed** (from C4):
  the conditional decrement (the shortfall test), a read-then-write balance
  update in place of `qty = qty + delta` (all four stock races), the
  version claim in `claimOrder` (both settle races and gate step 6), and
  the per-table lock (the booking-against-walk-in race, in each of three
  runs). Repeat that check after changing any of those guards, because a
  race test that passes with its guard removed proves nothing.
- **A suite whose assertions depend on the hour of the day fakes `Date`
  through `test/fake-date.ts` (`fakeDateOnly`, `nextNoonInJos`), the races
  and Reception suites included** (from the C4 review). Both booked today
  at 23:45 or 23:59 on the real clock, which Reception refuses as past in
  the last minutes of a Lagos day; the Reception suite was seen failing so
  at 23:59 WAT with every guard working. The helper holds the one list of timers left real, so the gate,
  the demo ports and the races cannot drift apart.

## Verification

- **Nothing is called verified unless it was compiled or run.** State what
  was not run rather than describing untested code as working: a claim nobody
  ran is how a broken guard reaches staging looking green, and the gates are
  planned from what the records say was checked.
- **Verify a guard by watching it fail with the guard removed.** A test that
  passes with and without the guard proves nothing about it.
- **The founder's own checks are recorded in their words** in
  `cnc-progress.md` in the workspace docs repository.
