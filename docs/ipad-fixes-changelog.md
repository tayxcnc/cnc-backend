# iPad fixes changelog: CNC backend (cnc-backend)

What each fix from the iPad fix pack and its batch 2 brief changed in this
repository, and every decision taken without the founder's confirmation.
Newest entries go at the top.

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
