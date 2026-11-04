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
