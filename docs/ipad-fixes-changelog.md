# iPad fixes changelog: CNC backend (cnc-backend)

What each fix from the iPad fix pack and its batch 2 brief changed in this
repository, and every decision taken without the founder's confirmation.
Newest entries go at the top.

## Faster public menu reads (Wave 5, PR 31)

Branch `perf/public-menu-reads` (platform fixes plan, wave 5, PR 31).
Closes B2 (CNC).

### What changed

- **Compressed answers.** Every response is compressed when the browser
  asks for it (Brotli or gzip, anything over 1 KB), added straight after
  helmet. The menu goes from about 41 KB to about 8 KB on the wire. Only
  answers are compressed, never requests, so Paystack's webhook signature
  is still checked over the exact bytes Paystack sent.
- **304 Not Modified.** The API already sent an `ETag`; a browser or the
  website asking again with `If-None-Match` gets an empty 304 while the
  menu is unchanged. Before this change that never happened on a menu
  with photos, because every read signed fresh photo links and so every
  answer was different.
- **Photo links are reused.** The public menu's photo links are signed
  for an hour, as before, and the same link is now handed out again while
  at least 45 minutes of it remain, from a list kept in memory (at most
  1,000 links, oldest dropped first). On staging each signature is a call
  to Google, one per photo, so a warm menu read now makes none. Photos on
  signed-in screens (staff, customers, the staff menu) are unchanged: ten
  minutes, signed afresh each time.
- **Menu thumbnails.** A new nullable column, `MenuItem.photoThumb`
  (migration `20261104121614_menu_photo_thumb`). Each menu photo uploaded
  from now on is stored with a 240 pixel WebP thumbnail beside it; both
  are replaced and removed together. `GET /menu` returns it as `thumbUrl`
  beside `photoUrl`.
- **Backfill for photos already stored.** `npm run media:backfill-thumbs`
  makes the thumbnail for every dish that has a photo and no thumbnail.
  Running it twice changes nothing the second time. If a manager replaces
  the photo while it runs, that dish is left alone. It refuses any
  database but a local one unless `CNC_SEED_THUMBS_ALLOW_REMOTE=true` is
  set for the run.
- **Staff changes still show at once.** Nothing about the menu itself is
  remembered between reads: a price change or a dish marked unavailable
  shows on the very next `GET /menu`. The API still says
  `Cache-Control: public, max-age=60`, so the website shows it within
  about 2 minutes (the API's 60 seconds plus the page's own 60 second
  revalidation).
- **Records.** `docs/conventions.md` (The public reads, Infrastructure,
  Data and migrations) and `CLAUDE.md` describe the above with reasons.

### API changes (additive)

- `GET /menu`: each item gains `thumbUrl` (string or null), a signed link
  to the 240 pixel WebP thumbnail. Null when the dish has no photo, or its
  photo was stored before thumbnails and the backfill has not run; show
  `photoUrl` then. `photoUrl` and `thumbUrl` are valid for at least 45
  minutes after the response.
- Every route: compressed when `Accept-Encoding` allows (`Vary:
  Accept-Encoding`). Every GET: a matching `If-None-Match` answers 304.
- Nothing renamed or removed. The staff menu response is unchanged.

### Tests

- `src/images/photo-store.service.spec.ts`: a public link is signed for an
  hour, reused at exactly 45 minutes left and signed again just under; one
  link per object; a signing failure is not remembered; the 1,001st link
  drops the oldest; signed-in links stay ten minutes and are signed every
  time; a menu upload stores a 240 pixel WebP thumbnail; a failed
  thumbnail write removes the photo; a thumbnail is made from a stored
  photo.
- `src/images/image-resizer.service.spec.ts`: the thumbnail fits inside
  240 at its own shape, is never enlarged, and keeps transparency.
- `test/public-reads.e2e-spec.ts`: the exact keys now include `thumbUrl`;
  gzip and Brotli when asked, none when not, same body; a 304 on
  `If-None-Match` with photo links in the body, and the same ETag on two
  reads; a price changed through the staff route shows on the next read
  with `public, max-age=60`, and the old ETag gets a 200 with the new
  price; a dish marked unavailable through the staff route is gone on the
  next read; photo and thumbnail links live an hour; a photo with no
  thumbnail answers `thumbUrl: null`.
- `test/menu.e2e-spec.ts`: an upload stores the thumbnail (240 by 120
  WebP for a 2000 by 1000 photo); a replacement and a removal delete the
  old thumbnail; an upload refused for a stale version leaves no object
  behind; the staff item has no `thumbUrl`.
- New `test/menu-thumbs-backfill.e2e-spec.ts`: the backfill makes each
  missing thumbnail once, reports a photo it cannot read and retries it,
  moves no version, and the menu then carries the thumbnail; a photo
  replaced during the run is left alone and the stray thumbnail deleted.
- `test/checkouts.e2e-spec.ts`: with compression on, a signed webhook is
  accepted, and the same event re-spaced is refused.
- The fake bucket's links now carry `X-Goog-Date` and `X-Goog-Expires`,
  as real ones do, so suites can read a link's life and tell two
  signatures apart.
- Each new guard was seen failing once with it removed, then put back:
  no link reuse (3 unit, 2 e2e failures), reuse down to 0 minutes left
  (1 unit failure), compression switched off (the gzip test), the
  backfill's "photo unchanged" condition (the race test), and the old
  thumbnail's removal (the upload test).

### Timings

Local only (this Mac, local Postgres 16, the built API, the seeded menu of
166 dishes in 12 sections, no photos, so no signing in either column).
Cold is the first request after the API started (restarted per call);
warm is the next 20, median and 95th percentile. The quote is a two-dish
pickup cart.

| Call | Before: cold | Before: warm median / p95 | After: cold | After: warm median / p95 |
| :--- | ---: | ---: | ---: | ---: |
| `GET /menu` | 98.8 ms | 3.2 / 6.4 ms | 64.4 ms | 4.3 / 8.0 ms |
| `GET /business` | 59.4 ms | 1.6 / 14.2 ms | 43.4 ms | 1.2 / 3.0 ms |
| `GET /opening-hours` | 38.9 ms | 1.1 / 2.1 ms | 36.2 ms | 1.2 / 2.2 ms |
| `GET /venues` | 49.7 ms | 2.0 / 4.2 ms | 46.0 ms | 2.4 / 4.2 ms |
| `GET /venues/dining/availability` | 63.5 ms | 3.9 / 6.2 ms | 69.6 ms | 4.9 / 10.0 ms |
| `GET /ordering/config` | 39.1 ms | 1.0 / 2.5 ms | 45.3 ms | 1.8 / 2.9 ms |
| `GET /ordering/slots` | 50.1 ms | 1.7 / 4.8 ms | 47.5 ms | 1.9 / 4.5 ms |
| `POST /ordering/quote` | 99.0 ms | 5.3 / 11.9 ms | 69.1 ms | 4.2 / 6.2 ms |

Menu size on the wire: 39,081 bytes before (uncompressed); after, 41,737
bytes uncompressed (the new `thumbUrl` keys), 7,770 with gzip and 7,997
with Brotli. A 304 for the menu took 2 to 3 ms locally. The local
differences in time are noise on a loaded machine apart from about 1 ms
of compression on the menu, which the smaller download repays many times
on a phone. What these numbers cannot show is the signing: on staging
each photo link is a call to Google's signing service, which the reused
links remove from warm reads; with no credentials here it was not timed.
Staging timings were not measured. Staging runs with `--min-instances 0`,
so the first request after a quiet spell starts an instance; keeping one
warm is the remaining fix for that and is left as a recommendation
(decision P50), with its cost not estimated here.

### Before merge: staging steps

1. Apply the migration to staging by hand with `npx prisma migrate
   deploy` through the Cloud SQL proxy, before the merge (as for every CNC
   migration). It only adds an empty column.
2. After the merge has deployed, if staging's menu has photos, make their
   thumbnails once: with the proxy running and `gcloud auth
   application-default login` done, run `CNC_DB_URL=<staging URL through
   the proxy, port 5433> CNC_GCS_BUCKET=tayxcnc-cnc-staging-media
   CNC_SEED_THUMBS_ALLOW_REMOTE=true npm run media:backfill-thumbs` (the
   local `.env` supplies `CNC_JWT_SECRET`). It prints how many it made;
   run it again if any failed. Until then those dishes show their full
   photo.

### Decisions made without confirmation

1. **Timings are local, not staging.** The plan asks for staging; staging
   is the founder's to touch. The local table above is before and after
   on the same machine; staging numbers are not run.
2. **Compression covers every route,** not only the public reads: one
   middleware, the same benefit for the staff app's large lists, and
   images are skipped by the package. Brotli is used when the browser
   offers it (the package's default, quality 4), gzip otherwise.
3. **`Cache-Control` stays `public, max-age=60`, with no
   `stale-while-revalidate`.** The brief suggests one; the plan does not,
   and it would let a cache show an old price or a sold-out dish for up
   to five more minutes.
4. **The `ETag` is Express's own weak one,** already on every GET; no
   custom tag was added.
5. **The link list is per instance and in memory.** Two instances sign
   their own links, so a conditional request that reaches the other
   instance gets a full answer instead of a 304; nothing is stale either
   way.
6. **The thumbnail fits inside 240 pixels at the photo's own shape** (a
   landscape photo becomes 240 by 135), not a cropped square, so a card
   can crop it as it likes. It is made from the stored 800 pixel photo,
   so an upload and the backfill give the same result.
7. **A thumbnail that cannot be written fails the upload,** and the photo
   just written is removed, so a photo is never stored without its
   thumbnail through the app.
8. **`thumbUrl` is null, not a copy of `photoUrl`,** when there is no
   thumbnail, so the website can tell the two apart (PR 32 uses
   `thumbUrl` when present).
9. **`thumbUrl` is on the public menu only.** The staff menu signs every
   link afresh; a second link per dish would double that work for a
   field no staff screen asked for.
10. **The backfill moves no version and writes no audit row.** The
    thumbnail comes from the photo and no screen edits it, so a staff form
    open on the dish still saves. Its remote-database flag follows the
    seeds' naming, `CNC_SEED_THUMBS_ALLOW_REMOTE`. It reads its settings
    through `CncConfigService`, so it needs `CNC_JWT_SECRET` like any
    boot; the local `.env` has it.
11. **No new indexes and no query changes.** The menu read is already
    two queries and takes about 3 ms warm locally; an index on 166 rows
    would not show. The brief's index item is not in the plan's
    paragraph.
12. **Merge style.** Merge commit, never squash (decision P1).
    `docs/conventions.md` (Git and workflow) still says feature PRs are
    squash-merged; flagged here and not edited, as P1 says.

## Long dashes and the bill read tests (CNC Staff App)

Branch `fix/copy-dashes-and-bill-tests` (platform fixes plan, wave 4, PR
24). Closes CS B1 (tests), CS B4, CS B6 (verified) and G2 (CNC backend).

### What changed

- **G2. The opening hours history has no long dash.** A change to the week
  used to read "Monday changed from 08:00–24:00 to Closed." It now reads
  "Monday changed from 08:00 until 24:00 to Closed." ("to" would read
  "from 08:00 to 24:00 to Closed"). It was the only text the server writes
  that held a long dash; code comments and the API documentation are left
  alone (P17). Rows already in the history keep their old wording, and
  the staff app's `cleanCopy()` tidies them when it shows them.
- **CS B4. Menu items and vendors refuse a long dash.** Saving a menu item
  whose name, description or photo text holds an en dash or an em dash,
  or a vendor whose name, phone, service type, contact person, email or
  address holds one, answers 400 "Please rewrite this without long
  dashes." and saves nothing. A hyphen ("Walk-in", "Slow-cooked") is
  fine. The check is one shared piece, `src/common/no-long-dashes.ts`,
  run inside each field's existing check, so a field still answers one
  sentence: a blank name still gets "Enter an item name and positive
  price." or "Enter the vendor name and phone.", and only a name that is
  otherwise good gets the dash sentence. The API documentation's 400
  descriptions for the menu and vendor saves name the new sentence.
- **Never on notes (P18).** Staff notes, reasons, tasks, anything a
  customer types and the business details still take a long dash, because
  an iPad turns a typed "--" into one and refusing it there would block
  daily work. A vendor's "Services / Procurement Notes" is a staff note,
  so it keeps taking one too. The app cleans these when it shows them.
- **The menu's three fields were converted to the one-sentence check**
  with their existing words kept: a missing name used to answer "Enter an
  item name and positive price." twice plus the length sentence; it now
  answers it once. A description or photo text that is not text answers
  "description must be text." or "photoAlt must be text." once, without
  the length sentence beside it.
- **CS B4. Seeds, emails and receipts.** Searched: the seeds, the seeded
  menu, the email templates, receipts, the bell and push text and every
  error message hold no long dash and no spaced hyphen, so nothing there
  changed. No price, tax rate or business detail changed.
- **An optional report of stored long dashes (P19),**
  `scripts/report-long-dashes.ts`. It lists every menu item and vendor
  value that holds a long dash, before and after, and writes nothing
  unless `--apply` is passed:

  ```
  npx ts-node -r dotenv/config scripts/report-long-dashes.ts
  npx ts-node -r dotenv/config scripts/report-long-dashes.ts --apply
  ```

  It reads only the fields the app now refuses a dash in, never the
  business details or the activity history. `--apply` refuses anything but
  a local database unless `CNC_SEED_DASHES_ALLOW_REMOTE=true` is set for
  the run. Running it twice is safe. Staging is wiped and production starts
  from seeds that hold no long dash, so no database is expected to need it.
- **CS B1. The bill read is pinned by tests, with no new route (P21).**
  History > View already opens a bill with `GET /staff/orders/:id`, which
  returns every printed field and writes nothing. New tests prove it: an
  open, a settled and a cancelled bill are each read three times, the
  answers are identical, and no audit, payment or docket row is added and
  the bill's version does not move. A Bartender is refused a Restaurant
  bill ("Bartenders can operate Bar POS only.") and still reads a Bar
  bill; the Kitchen is refused; a Waiter, a Cashier, a Manager and the
  Owner all read a settled bill and get the same answer. Who may read it
  is unchanged.
- **CS B6. Date range rules: verified, no change.** The routes that take a
  `from` and `to` (Activity History, Attendance and every report) include
  the whole of the `to` day in Lagos and refuse a `from` after `to` with a
  400. Existing tests already pin this: `test/audit.e2e-spec.ts` ("filters
  a manager's read by module, action, staff and WAT dates"),
  `test/reports.e2e-spec.ts` ("to must not be before from.", and the
  Lagos midnight cases), `test/attendance.e2e-spec.ts` and
  `src/common/date-range.spec.ts`. Reservations and Online Orders take a
  single `date` (or none), not a range, so there is nothing to check there.
- **Records.** `docs/conventions.md` (Errors) has the long-dash rule and its
  reason; `CLAUDE.md` points at it and lists the report script.

### Tests

Updated to the new values, not loosened or removed:

- `src/settings/opening-hours.spec.ts` and `test/settings.e2e-spec.ts`:
  "08:00 until 24:00".

New:

- `src/common/no-long-dashes.spec.ts` and `src/common/checked.spec.ts`
  (`textUpTo`): the dash sentence, a hyphen passing, the field's own
  sentence first and alone, optional fields, `OptionalText` refusing a
  dash only when asked.
- `test/menu.e2e-spec.ts`: a dash in a new item's name, description or
  photo text is refused and adds nothing; in a change it is refused and
  the item and its version stay as they were; each field's own sentence
  still comes first, once.
- `test/purchasing.e2e-spec.ts`: a dash in each vendor field but the notes
  is refused and adds nothing; the notes keep one; an edit with a dash
  changes nothing.
- `test/order-payments.e2e-spec.ts`, "the bill read (CS B1)": the two
  tests described above.
- `scripts/report-long-dashes.spec.ts` and
  `test/report-long-dashes.e2e-spec.ts` (its own database): what the
  report finds, that a report writes nothing, that a value changed since
  the read is skipped, that `--apply` cleans and moves each version, that
  a second run does nothing, and that the business details, the history
  and a vendor's notes are untouched.

Each new guard was seen failing once with its guard removed, then put
back: with the dash check removed from `noLongDashes`, three unit tests,
both menu dash tests and the vendor dash test failed; with the bill read
changed to move the bill's version and its department check removed, both
bill read tests failed; with the report's "still the value read"
condition removed, the skip test and the apply test failed.

### Before merge: staging

Nothing. No migration, no seed change and no setting.

### Decisions made without confirmation

1. **A vendor's notes take a long dash (P18).** The plan says "vendor
   fields", but the notes field is "Services / Procurement Notes", a note
   staff type, and P18 never refuses a staff note. Every other vendor
   field, phone and email included, refuses one.
2. **The message is CS B4's, "Please rewrite this without long dashes."**,
   as the plan says, and names no field (TAY's names the field; the two
   backends share no code). The staff app shows it under the form that
   sent it.
3. **The field's own sentence comes first.** A blank or over-long name
   answers its existing sentence; the dash sentence is only for a value
   that is otherwise good, so one field never answers two sentences.
4. **The menu fields now answer one sentence where they answered two or
   three** (a missing or non-text name, description or photo text). The
   words are the same; only the repeats are gone. No screen parses these
   sentences (checked in `cnc-frontend` on `develop` and its feature
   branches).
5. **"until" in the opening hours history**, as the plan says, rather than
   "to", which would make "from 08:00 to 24:00 to Closed".
6. **The report is a script, not a migration (P19)**, reads exactly the
   fields the app now refuses a dash in, moves each written row's version
   (so a form opened before the run asks for a refresh rather than saving
   the old text back) and writes no audit row (it is an operator's one-off
   run, recorded here). It has no npm script; the command is in its header.
7. **CS B1: no new route and no narrower access (P21).** The brief's "a
   Cashier reads only their own till and today" is not applied: CNC has no
   till record, and narrowing would break the cashier's History > View.
   Roles outside the Point of Sale, such as the Kitchen, are refused as
   they already were.
8. **CS B6: verified, no change.** No new test was added because the
   existing ones listed above already cover both rules.
9. **No seed or price changed.** The seeds hold no long dash, so there was
   nothing to clean; a guard over the seed files was not added, as it is
   not in this pull request's scope.

## Receipt paper and staff photo reads (CS B2, CS B5, CS B3)

Branch `feat/print-paper-and-photo-reads` (platform fixes plan, wave 1,
PR 13). Closes CS B2, CS B5 and CS B3 (verified, no change).

### What changed

- **CS B2. New installs start on 58 mm paper.** The seed
  (`prisma/seed-data/reference.ts`) sets `printerWidth` to `MM58` instead
  of `MM80`. The existing setting is reused: it is already served on
  `GET /staff/settings` and `GET /staff/reference`, already editable in
  Settings > Receipt Printer by the Owner and Managers, and already read by
  the staff app, so no new `receipt_paper_width_mm` field is added. No
  schema change and no migration: the column default stays `MM80`.
- **The staging settings row keeps its current paper.** The seed never
  overwrites a settings row that exists, so staging (and any database
  seeded before this) stays on whatever it holds now, 80 mm unless someone
  changed it, until 58 mm is chosen once in Settings > Receipt Printer
  (plan 7.3 step 18). A database seeded after this starts on 58 mm.
- **CS B5. Two photo reads that a canvas can use.** The Staff ID card's
  photo is a signed Cloud Storage link, and the bucket has no CORS policy,
  so the staff app cannot draw it into a canvas or a PDF. Two new routes
  stream the photo from the API instead:
  - `GET /staff/me/photo`: your own photo, any role.
  - `GET /staff/people/:id/photo`: exactly the card's rule. Managers only
    (`@Roles()`), and a Manager's or the Owner's photo only for the Owner
    or its holder (`mayReadCard`, "Only the Owner can open a Manager or
    Owner Staff ID."), checked before anything is read from the bucket.
  - Both answer the bytes stored at upload, already the 320-pixel square
    with metadata removed, with their own content type (`image/jpeg`,
    `image/png` or `image/webp`). Nothing is resized on the way out.
  - Both answer `Cache-Control: private, max-age=300` and add
    `Authorization` to `Vary`, so a shared tablet never shows the next
    person the previous person's photo from the browser cache. CORS's own
    `Vary: Origin` is kept.
  - No photo, or a recorded photo no longer in the bucket: 404 "This staff
    account has no photo.". No account: 404 "Staff account not found.".
    A bucket that cannot be read: 500, never "no photo".
  - They read through a new `MediaStorage.read()` (Cloud Storage and the
    test fake) behind `PhotoStore.read()`, so `ImagesModule` is still the
    only way into the bucket.
- **The Staff ID QR payload is unchanged.** Nothing here touches
  `staff-qr.ts`, the card route or its `no-store`.
- **CS B3. Verified, no change.** One response already carries every
  printed field: a receipt or bill is `GET /staff/orders/:id` (lines,
  options, totals, VAT, service, discount, deposit, every payment) plus the
  business lines on `GET /staff/reference`; a docket is
  `GET /staff/dockets/:ref` (ref, order ref, revision, date, time, staff,
  notes, items). Reprinting writes only an audit row
  (`POST /staff/audit/print`); a confirm with no change answers
  `reprint: true` and writes no new docket; the replacement notice follows
  from `revision` above 1. Customer order receipts are emailed only.
- **Records.** `docs/conventions.md`: the seeded paper (*Money controls
  and the audit log*, beside the print record), the streamed staff photo
  and its caching (*Infrastructure*), the photo read following the card's
  rule (*Auth*), and the settings row in tests (*Local environment*).
  `CLAUDE.md` points at them.

### Tests

- `prisma/reference-data.spec.ts`: the seed's settings hold `MM58` (was
  `MM80`). The check that the seed equals the C3 migration's column
  defaults now names the one intended difference: the defaults hold
  `MM80`, the seed `MM58`.
- New, `test/seeded-settings.ts` (`createSeededSettingsIfMissing`), used by
  the seven suites on the shared test database that created the settings
  row from the column defaults (`money-control`, `order-payments`,
  `orders`, `settings`, `shell`, `stock`, `stock-requests`). On a fresh CI
  database a row created from the defaults would now hold 80 mm and fail
  the seed suite's "one settings row holding Q7's values", depending on
  which suite ran first. Seen failing that way on a fresh local database
  (the shell suite with the old line, then the seed suite: `printerWidth`
  expected `MM58`, got `MM80`), and passing with the helper.
- `test/staff-card.e2e-spec.ts`, new cases:
  - your own photo, as a waiter and as the Owner: 200, the stored bytes,
    `image/jpeg`, the length, the caching headers, 320 by 320;
  - a Manager reads a waiter's photo: 200;
  - a Manager is refused the Owner's photo with the card's sentence (403),
    and the Owner reads it;
  - a waiter is refused another person's photo, and its own through the
    managers' route, with the role sentence (403), as the card does;
  - 404 for no photo, a photo gone from the bucket and no account; 401
    with no token;
  - 500 when the bucket cannot be read.
  - every refusal, 404 and 500 carries neither a `max-age` nor
    `Vary: Authorization` (`expectNoPhotoCaching`). Seen failing with
    `Vary: Authorization` set on the people route before the read (the 403
    and 404 cases), then put back.
- `test/settings.e2e-spec.ts`: the "change the printer" case now saves the
  width the row does not hold (`MM80` when it holds the seeded `MM58`), so
  it still proves the printer changes now that the row starts on 58 mm.
- New, `src/storage/gcs-media-storage.spec.ts`: the Cloud Storage binding's
  `read` against a stand-in client (bytes and type from the URI's bucket,
  a generic type when none is stored, null on a 404 from either call,
  any other error thrown, a bad URI refused before the client is called).
- `src/images/photo-store.service.spec.ts`: `PhotoStore.read` answers the
  stored bytes, null for no photo or a missing object, and throws when the
  read fails.
- Each new rule was seen failing with it removed, then put back:
  removing `mayReadCard` from the photo route fails the Owner's photo
  case; removing `@Roles()` fails the waiter case; removing the `Vary`
  line, or setting `Vary` instead of appending to it, fails the three 200
  cases; treating every storage error as "not found" fails the Cloud
  Storage spec.

### Before merge

No migration, so nothing is applied to staging. After the merge, if the
staging settings row is still on 80 mm, choose 58 mm once in Settings >
Receipt Printer (plan 7.3 step 18). The staff app starts using the photo
routes in PR 14.

### Decisions made without confirmation

1. **The existing `printerWidth` is the workspace paper setting (P23,
   P20).** No `receipt_paper_width_mm` field; the camelCase enum the staff
   app already reads does the job.
2. **The column default stays `MM80`; only the seed moves (P23).** The
   plan rules out a schema change. A row is only ever created by the seed,
   so production starts on 58 mm.
3. **Test suites create the settings row from the seed's values.** This
   follows from decision 2: the seed and the column default now differ, so
   the seven shared-database suites that relied on them being equal would
   have made the seed suite order dependent. The two suites on databases
   of their own (`kitchen`, `reception`) keep their line: their rows never
   meet the seed suite.
4. **Photo routes instead of the brief's resize and 15-minute link
   (P25).** A streamed photo has no link to expire, and the bucket's CORS
   (an open infrastructure decision) is not changed. The 10-minute signed
   link on the card stays as it is.
5. **The photo stays at 320 pixels, not the brief's 512 (P25).** The brief
   asks for a resize only if one is missing; 320 pixels covers the card's
   photo frame at print resolution.
6. **Five minutes of browser caching, varied by `Authorization`.** The
   plan's figure for TAY's photo routes; the `Vary` keeps a shared tablet
   from showing one person's cached photo to the next. A replaced photo may
   show the old one for up to five minutes unless the screen asks with a
   fresh URL.
7. **A missing object is "no photo" (404); an unreadable bucket is a
   500.** The first is the truth about the person; the second is not, so
   the screen can retry instead of drawing the placeholder for good.
8. **The waiter's own photo is refused on the managers' route**, as its own
   card is there; everyone reads their own through `/staff/me/photo`.
9. **CS B3 needs no backend change.** No `isReplacementDocket` flag:
   `revision` above 1 is the existing, equivalent rule, and adding a
   print-shaped endpoint would break the rule that prints read the same
   data as the screen.
10. **Merge style.** Merge commit, never squash (P1).
    `docs/conventions.md` (Git and workflow) still says feature PRs are
    squash-merged; it is flagged here and not edited.
11. **Additive only (P20).** Two new routes, one new message, one new
    storage method; no route, field or message renamed or removed.

## Contact details (batch 2, section 2)

Branch `fix/contact-details-batch2` (platform fixes plan, wave 0, PR 1).
Closes B1 (CNC), S2-SEEDS, S2-PHONES (backend text), S2-INSTAGRAM (data),
S2-EMAILS-RECEIPTS, SEARCH-CLEAN (CNC backend), S2-WHATSAPP (none found) and
G15 (this changelog).

### What changed

- **B1. CNC's number and Instagram in the stored business details.** A new
  migration, `20261103203708_contact_details_batch2`, updates the one
  Business row (Settings > Business Details) on a database that already has
  it, which is the case on staging:
  - the phone becomes `09113500003`, which the website, the staff app,
    receipts and emails show as `0911 350 0003`;
  - Instagram becomes `https://www.instagram.com/chefnoroculinary`. Any
    other social link already saved stays exactly as it is, and an older
    Instagram link is replaced, as the brief asks;
  - the row's version moves by one, so a Settings page that was open
    before the change cannot save the old number back: it gets the usual
    "someone else changed this" answer and reloads.
- **It only touches a row that still has the old number.** If staff have
  already typed a different phone in Settings, the row is left exactly as
  it is. The old number is recognised however it was stored: starting `0`,
  `234` or `+234 (0)`, with or without spaces, hyphens or brackets.
- **Running it twice is safe.** After the first run the phone is the new
  number, so a second run finds nothing and changes nothing. It is a data
  change only: no table or column changes (`prisma migrate diff` prints an
  empty migration).
- **S2-SEEDS. A fresh install gets the new details.** The seed
  (`prisma/seed-data/reference.ts`) now holds `09113500003` and the
  Instagram link. The seed still never overwrites a row that exists; the
  migration is what changes an existing one.
- **S2-EMAILS-RECEIPTS. Emails and receipts.** No email or receipt holds a
  phone number of its own: the booking and order emails read CNC's number
  from the business details and show it as `0911 350 0003`, and receipts
  are printed from the same details. Once the row is updated, they all
  show the new number with no code change. Only their tests changed.
- **S2-PHONES (backend text).** The example in the Settings error message
  now reads "Enter the business phone as a Nigerian number, for example
  0911 350 0003." The API documentation examples (phone and Instagram) and
  the code comments now show CNC's new number and Instagram link.
- **TAY's number never appears here.** This repository is CNC's only; it
  holds no TAY number (0911 350 0004), and nothing was added.
- **X, Facebook and TikTok.** Nothing here sets, removes or changes them.
  The migration keeps any such link already saved.
- **S2-WHATSAPP: none found.** There is no WhatsApp link, in either of the
  two forms the brief names, and the word WhatsApp appears nowhere in the
  code, the seed or the migrations, so there was nothing to update.
- **SEARCH-CLEAN. A guard against the old number.** A new test,
  `scripts/old-business-phone.spec.ts`, reads every file under `src/`,
  `prisma/` (migrations left out), `scripts/` and `test/`, and fails if
  the old number appears in any spelling: with spaces, hyphens, the dashes
  an iPad or a pasted document puts in place of a hyphen, underscores,
  brackets, dots, `0`, `234` or `+234`, or split across a comment's line. The old
  number is kept in `test/old-business-phone.ts` in pieces, so neither the
  guard nor the search below finds the test files themselves. Before the
  other changes were made, the guard was run and failed on all 29 places
  the old number then appeared.
- **Records.** `docs/conventions.md` (Bookings from the website and the
  app) now shows the new number and names the guard. `.gitignore` lets this
  changelog into the repository; everything else in `docs/` except the
  three records already tracked stays out.

### Tests

Updated to the new values, not loosened or removed:

- `prisma/reference-data.spec.ts`: the seed's business details hold
  `09113500003` and the Instagram link.
- `src/mail/mail-templates.spec.ts` (7 lines): the booking, reminder,
  receipt, order status and refund emails say "call CNC on 0911 350 0003".
- `src/common/nigerian-phone.spec.ts`: `09113500003` is shown as
  `0911 350 0003` and is already in the stored form.
- `test/settings.e2e-spec.ts`: a manager saving `+234 911 350 0003` gets
  `09113500003` stored.
- `test/schema.e2e-spec.ts`: the one-row check uses the new number.
- `test/customer-messages.e2e-spec.ts` and
  `test/online-order-messages.e2e-spec.ts`: the cancelled booking email and
  the order receipt say "0911 350 0003".
- New, `test/contact-details-migration.e2e-spec.ts`: runs the migration
  twice against a database of its own, starting from:
  - the old row, stored as digits and as `+234 802 …` with spaces: the
    phone and Instagram change, Facebook stays, the version moves once,
    and the second run changes nothing;
  - a phone staff typed (`08031234567`): nothing changes, on either run;
  - social links stored as a list (`[]`) instead of an object: only the
    phone changes, the list stays as it was, and the second run changes
    nothing.

  Removing the "still the old number" condition from the migration makes
  every case fail; removing the "only an object" condition makes the list
  case fail. Both were checked by removing them, running the suite, and
  putting them back.

### Old number search

Run in the repository root (the search from section 7.1 of the platform
fixes plan, with `prisma/migrations` left out, because the new migration
has to name the old number to find it). It printed nothing.

```
grep -rnIE "0802[ ()-]*218|\+?234[ ()-]*802[ ()-]*218|802[ ()-]*218[ ()-]*8797|wa\.me|api\.whatsapp\.com" --exclude-dir={node_modules,.next,.git,generated,dist,migrations} .
```

### Before merge: one step on staging

Apply the migration to staging by hand with `npx prisma migrate deploy`
through the Cloud SQL proxy, before the merge (as for every CNC migration).
Afterwards Settings > Business Details on staging shows `0911 350 0003` and
the Instagram link, unless someone had already typed a different phone
there, in which case the row is left as they saved it and the phone and
Instagram are changed by hand in Settings.

### Decisions made without confirmation

1. **A row with a phone staff typed is left completely alone, Instagram
   included (decision P43).** The migration changes the business details
   only while the phone is still the old number. If staff have already
   changed the phone in Settings, the details are theirs, so their social
   links are not touched either; Instagram is then set by hand in Settings.
2. **On a row that is updated, the Instagram link replaces any earlier
   one**, as batch 2 says, and every other social link stays.
3. **Social links that are not an object are left as they are.** The
   service already reads anything else as "no links", and turning a list
   into an object would change data the migration was not written for. On
   such a row only the phone changes.
4. **No audit log row for the migration.** The audit log records what a
   person did in the app; this change is a one-off data update made by
   whoever applies the migration, recorded here and in the migration's own
   comments.
5. **The guard reads `scripts/` and `test/` too, not only `src/` and
   `prisma/`.** A test or a script that spelled the old number would put it
   back in the search results, so the guard covers every folder the
   repository runs.
6. **The old number is kept in one test helper, in pieces**
   (`test/old-business-phone.ts`), shared by the guard and the migration
   suite, so it is written once.
7. **Emails already waiting to be sent are not changed.** An email queued
   before the migration ran was written with the old number when it was
   queued (queued emails are sealed), and is sent or expires as it would
   have. Every email queued afterwards uses the new number.
8. **Merge style.** Merge commit, never squash (decision P1).
   `docs/conventions.md` (Git and workflow) still says feature PRs are
   squash-merged; it is flagged here and not edited, as P1 says.
9. **Only Instagram is a link (decision P42).** X, Facebook and TikTok are
   not touched; this repository has no icons, only the stored links.
10. **The changelog is let into git (decision P7)** with
    `!docs/ipad-fixes-changelog.md` in `.gitignore`, because `docs/*` is
    ignored here.
11. **The backend change is additive (decision P20).** No route, field or
    message key was renamed or removed; only values, examples and one
    message's example number changed.
12. **No other repository changes here (decisions P41, P44).** TAY's
    contact constant and the entrance page are other pull requests.
