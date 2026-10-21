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
  response.** TAY emails it; CNC has no mail until C6, so the manager hands
  it over in person, and C6 may move it to email. It is never stored in
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

## Money controls and the audit log *(from C3)*

- **Every Owner-only, limit and own-record rule goes through
  `MoneyControlService` (`src/money-control/`), and its sentences are the
  exported constants there, never retyped** (plan §6.2). `ownerOnly` with
  `OWNER_ONLY_ACTIONS`, `requireOwner` with the price, new-item and
  settings sentences, `withinLimit` with `LIMITED_DECISIONS`, `notOwn` with
  `OWN_RECORD_KINDS`, `mayChangeAccount` and `keepsAnActiveOwner` for staff
  accounts. The screens show these refusals verbatim (A7); one home per
  sentence is the only way two commands applying the same rule print it the
  same way.
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
  absolute amount.
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
