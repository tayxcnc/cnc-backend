# CNC Backend: Standing Instructions

**`docs/conventions.md` is the canonical record.** If this file and that one
disagree, that one wins. Do not restate rules here: add them there, each with
its reason, and point at them from here.

The plan and the progress record live in the workspace docs repository, beside
this one, not in it:

- `TAYxCNC/docs/cnc-phase-plan.md`: the approved plan. Architecture decisions
  A1 to A22 (§3), the TAY patterns copied (§11), environments (§12), phases
  and cards (§15), the founder's questions (§18). Read the card before
  starting work that maps to one.
- `TAYxCNC/docs/cnc-progress.md`: what was done, verified and decided, and
  the founder's answers and gate results in their words.

TAY's backend (`TAYxCNC/tayxcnc-backend`) is the pattern source. Copy its
files and adapt them; never import from it and never edit it.

## Where the rules live

Every entry below is a pointer, not a rule. Read the named section of
`docs/conventions.md` before working in that area.

| Topic | Section |
| :--- | :--- |
| What CNC shares with TAY (nothing) | Isolation from TAY |
| Route prefix, REST paths, JSON casing, timestamps | Contract conventions |
| Money fields and the `*Kobo` integer rule | Contract conventions |
| Business dates, `Africa/Lagos`, `wat.ts` | Contract conventions |
| Enums on the wire and the frontend adapters | Contract conventions |
| Pagination shape | Contract conventions |
| Error body, messages kept byte for byte, status codes | Errors |
| `version` and the stale-write 409 | Optimistic concurrency |
| `Idempotency-Key` and its CORS consequence | Idempotency |
| The `CNC_` prefix, the `TAY_` refusal, `check:env-names` | Configuration |
| Deployed and production boot rules, `CNC_WEB_URL` base path | Configuration |
| The Prisma `7.10.0` pin, `prisma-client-js`, the driver adapter, pool size | Data and migrations |
| `migrate dev` local only; `migrate deploy` by hand before the merge | Data and migrations |
| Raw-SQL `now()`, `P2002`, sequences | Data and migrations |
| Staff and customer sign-in, cookies, guards (from C3) | Auth |
| Customer email codes: caps, tries, sentences, `OtpService`, `CncCustomerGuard`, creating customers | Auth |
| Email: the outbound queue, sealed payloads, expiry, the retry backoff, the transports, the mail frame, Reply-To, `sentMail` in tests | Mail and the outbound queue |
| `GET /me/notifications`, what writes an item, unread, the booking reminders (Q32) and `reminderSentAt` | The customer's in-app list and booking reminders |
| `POST /enquiries`, `POST /group-enquiries`: honeypot, the two limits, the inbox email (Q20) | Enquiries |
| The Cloud Scheduler sweep jobs, their schedules and how to create them | Infrastructure |
| `PATCH /me`, phones, the delivery address module, prefs, the email change, the customer photo, deleting an account (Q36), `HOLDING_STATUSES`/`UNSETTLED_ORDER_STATUSES` | The customer's account |
| Public reads: what they expose, `PublicCache` and `no-store`, Q37, availability, the ordering times, no throttle | The public reads |
| Owner rules, approval limits, the ledger, audit rows and reads | Money controls and the audit log |
| One sentence per request field (`@Checked`, `@AdminReason`, `@ValidLines`) | Errors |
| Partial unique indexes and their names | Data and migrations |
| The stock ledger, locations, counts and Q28, valuation, comparison rules | Stock |
| The C5 tables' CHECKs, one open shift per person, task links, pack cost | Stock requests, purchasing, waste, tasks, assets and attendance: the schema |
| Stock requests: location, packs, issue, own record, reads, history | Stock requests |
| Purchases, approvals and their limits, receiving, R1's automatic tasks, vendors, the lite list, the assigned-task bell item | Purchasing and vendors |
| Waste: each role's location, stock on approval, Q25's per-pack value, approvals, corrections of approved records (day limit, own record), the read and history | Waste |
| `GET /staff/approvals`: a read only, what awaits whom, `approvalRefusal` and `standing()`, fresh waste values | Approvals |
| `task.save`: the role gate, who may raise and save what, links, assignees, history, who sees which task | Tasks |
| `asset.save` by tag, repairs, the asset following its repair, R3's resolved date, the follow-up task, the MT- reader, the assets lite list | Assets and repairs |
| The QR scan and its token, repeats and overnight shifts, the per-person lock, corrections, the reads, the "Attendance review" export | Attendance |
| Bills, lines, totals, dockets, reprints, order history readers | Orders and dockets |
| Payments, settle and its race, Bar stock on settle and reverse, discounts, cancel, reopen | Payments, settlement and bill corrections |
| Kitchen entries, corrections, the day's close, the crosscheck, the cash count | Kitchen entries, the kitchen day and the cash count |
| Business dates in requests (`calendarDate`) | Errors |
| Bookings, arrival rules and Q30, the table lock, seatings, the floor, the Free Table Reminder, Q35 | Reception: bookings, table sessions and the floor |
| `POST /reservations` (guest or customer), the customer link both ways, `/me/reservations`, the 24-hour rule (Q6), booking emails, the booking throttle | Bookings from the website and the app |
| The allowlist, rejection, credentials, methods, headers | CORS |
| Region, service accounts, WIF, `--set-secrets`, placeholders | Infrastructure |
| Photos, `PhotoStore`, the media bucket and its test fake | Infrastructure |
| Staff accounts: R2, session revocation, first passwords, QR reissue | Auth |
| Staff ID cards and the QR payload; the sweep routes and the tokens sweep | Auth |
| Suites that need a database of their own (`createIsolatedDatabase`) | Local environment |
| The print record (`POST /staff/audit/print`); printing from API data | Money controls and the audit log |
| A controlled clock in tests (fake `Date` only); the C4 gate walk and race suites | Local environment |
| Shared-row e2e suites, seeded rows in tests | Local environment |
| TAY staging resources CNC work never touches | Infrastructure → Never touched from CNC work |
| Editor tools only, no `sed`/`awk`/`perl` | Making changes to source files |
| Branches, merges, PRs, commit identity, hooks, attribution | Git and workflow |
| Local Postgres, the proxy port, secret handling, clean clones | Local environment |
| What may be called verified | Verification |

**Isolation** is the one thing to internalise rather than look up: CNC and TAY
share no data layer, no auth realm and no environment. CNC never reads a
`TAY_*` variable, and reads nothing unprefixed except `PORT` and `NODE_ENV`.
It is enforced at boot by `CncConfigService` and in CI by `check:env-names`.
The reasoning is under *Isolation from TAY* and *Configuration*.

## Commands

```
npm run start            # watch mode
npm run build            # nest build
npm test                 # jest unit tests
npm run test:e2e         # jest, test/jest-e2e.json (locally: -- --maxWorkers=2)
npm run lint             # eslint --fix
npm run check:env-names  # fails on any env read that is not CNC_*, PORT or NODE_ENV
npm run mock             # prism mock against openapi-cnc.json, port 4014

npm run db:generate      # prisma generate, to generated/cnc-client
npm run db:migrate       # prisma migrate dev, LOCAL ONLY
npm run db:seed          # reference data, menu, paired Bar stock (also Prisma's seed key)
npm run db:seed:owner    # the first Owner, by hand only (never the seed key)
```

## Layout

```
src/
  main.ts            entry point; boots CncAppModule
  bootstrap.ts       prefix, pipes, helmet, CORS (list from CncConfigService)
  app.module.ts      CncAppModule
  cnc-swagger.ts     Swagger UI and the openapi-cnc.json export (not in production)
  config/            CncConfigService, the only reader of the environment
  audit/             AuditService (the one writer), GET /staff/audit and its
                     sentences, AuditRefAccess for non-manager record reads,
                     POST /staff/audit/print (the print record)
  auth/              staff sign-in, refresh, sign-out, change-password, admin reset;
                     CncStaffGuard, @Roles, @CurrentStaff; tokens, cookies, argon2id
  money-control/     MoneyControlService: Owner-only rules, approval limits and
                     the daily ledger, own record, Manager/Owner accounts, last Owner;
                     standing() and approvalRefusal() for the approvals read
  common/            money, dates, errors, pagination, request helpers, QR tokens
                     and their SVG renderer, the client-address throttler guard,
                     one-sentence field checks, the admin reason, item lists
  health/            liveness and readiness
  idempotency/       Idempotency-Key: the service, decorator and scopes
  internal/          the Cloud Scheduler sweeps: SweepTokenGuard, the tokens,
                     messages and reminders sweeps
  customers/         the customer email-code sign-in (/auth/code, verify, refresh,
                     sign-out), the account (/me: profile, email change, photo,
                     DELETE); CustomerService (the one creator of customers),
                     OtpService (codes and their caps), CustomerEmailService,
                     CustomerDeletionService, profile-rules.ts
  ordering/          the public ordering reads (GET /ordering/config, /slots) and
                     the ordering times (ordering-times.ts); C7 adds checkout
  mail/              the outbound queue (OutboundMessagesService, its retry
                     backoff), templates, the CNC mail frame, MessageSeal, the
                     Resend and recording transports
  customer-notifications/  the customer's in-app list (GET /me/notifications,
                     POST /me/notifications/read), CustomerNotificationsService
                     (the one writer), the items' words
  enquiries/         POST /enquiries and /group-enquiries: honeypot, the stored
                     cap and the throttle, the email to CNC's inbox
  images/            PhotoStore: byte inspection, sharp resizing, the upload route
                     decorator; the only importer of storage/
  storage/           MediaStorage and its Cloud Storage binding (gs:// URIs, V4 links)
  staff/             Staff & Access: staff.save, staff.photo, the ID reissue,
                     staff ID cards (the QR payload in staff-qr.ts)
  settings/          settings.save, business details, opening hours; the public
                     GET /business and GET /opening-hours
  menu/              Menu & Prices: menu.save, photos, the paired Bar stock item;
                     the public GET /menu
  stock/             the stock core: StockLedgerService (the one writer of balances
                     and movements), balances and movements reads, issue, count,
                     Correct Balance, stock items, kitchen comparison rules;
                     stock requests (StockRequestsService, the SR- history reader)
  purchasing/        Purchasing and Vendors: PurchasesService (create, edit,
                     approve, reject, status, archive, receive), purchase rules,
                     the PR- history reader; VendorsService (vendor.save)
  waste/             Waste: WasteService (create, approve, reject, edit, status),
                     the waste rules, the W- history reader
  approvals/         Approvals: GET /staff/approvals (ApprovalsService), what
                     each pending requisition or waste entry awaits
                     (approval-rules.ts)
  tasks/             Tasks: TasksService (task.save, the tasks read), the task
                     rules, the T- history reader; the automatic tasks (raise,
                     close, who gets them) and the assigned-task bell item
  assets/            Assets & Maintenance: AssetsService (asset.save, the assets
                     read), MaintenanceService (maintenance.save, the repairs
                     read), the repair rules, the MT- history reader
  attendance/        Attendance: AttendanceService (the QR scan, the correction,
                     the directory, a person's month, My Attendance, the
                     Attendance review export), the attendance rules
  orders/            Point of Sale: bills and lines (claimOrder, readOrder,
                     orderTotals), kitchen dockets (DocketsService, the one
                     docket writer), the bill and docket history readers;
                     payments, settle and the corrections (OrderPaymentsService)
  kitchen/           Kitchen: kitchen.save and kitchen.close (KitchenService),
                     the entries and day reads, the Kitchen Crosscheck report
                     (crosscheck(), the demo's function)
  cash/              cash.count and the Cash Reconciliation report
  reception/         Reception: bookings (ReservationsService.book, the one
                     booking command), table sessions, the floor read, the
                     Free Table Reminder; arrival rules in reservation-rules.ts;
                     the public GET /venues and availability; the website's
                     and the app's POST /reservations and /me/reservations
                     (CustomerReservationsService), the customer link
                     (customer-link.ts), the booking emails and in-app items
                     (ReservationMail), the reminders (ReservationRemindersService)
  notifications/     GET /staff/notifications, the staff bell (C8-2 completes it)
  shell/             GET /staff/me, /staff/me/card, /staff/reference (assets lite
                     for Reception and managers), the overview layout
  prisma/            CncPrismaService, sequences, claimVersion, Prisma error helpers
prisma/
  schema.prisma      generates to generated/cnc-client (gitignored)
  migrations/
  seed.ts, seed-owner.ts   the two seed entry points (data-seed.ts, owner-seed.ts do the work)
  menu-seed.ts       joins the copied menu sources; refuses a disagreement
  seed-data/         copies of cnc-frontend's menu, id map and floor plans; Q7 values
test/                e2e specs (c4-gate: the C4 gate walk; c4-races: the
                     acceptance races; c5-schema: the C5 migration's CHECKs;
                     purchasing: the C5 gate's steps 1 to 3; waste: steps
                     5 and 6; tasks: task.save and who sees which;
                     assets-maintenance: assets and repairs; attendance:
                     the scan, corrections, reads and step 7;
                     approvals: the approvals read and the C5 races;
                     c5-gate: the C5 gate walk, steps 1 to 7;
                     customer-auth: the email-code sign-in, its caps,
                     the realms, the outbound queue and TAY's cookies;
                     customer-account: /me, the email change, the photo,
                     deletion; public-reads: the C6-4 public reads;
                     customer-reservations: web and app bookings, the
                     link, change and cancel, the races and the 24-hour
                     boundary; customer-messages: the in-app list, the
                     reminders sweep, the messages sweep's backoff and
                     attempts cap; enquiries: both forms, the honeypot,
                     the limits),
                     create-test-app.ts, staff-fixtures.ts,
                     staff-sessions.ts, isolated-database.ts,
                     fake-media-storage.ts, shared-rows-lock.ts, test-images.ts
scripts/             check-env-names.ts
```

## Working style

- Confirm understanding before generating anything substantial, and flag a
  conflict with the plan rather than silently reconciling it: the plan is
  the founder's approved record, and a quiet deviation is one nobody agreed.
- The rules on verification, secrets, file edits and attribution are in
  `docs/conventions.md`: *Verification*, *Local environment*, *Making changes
  to source files*, *Git and workflow*.

Never add AI attribution or a `Co-authored-by` trailer to a commit message or
a PR description (*Git and workflow*).
