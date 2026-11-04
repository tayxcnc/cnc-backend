# iPad fixes changelog: CNC backend (cnc-backend)

What each fix from the iPad fix pack and its batch 2 brief changed in this
repository, and every decision taken without the founder's confirmation.
Newest entries go at the top.

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
  otherwise good gets the dash sentence.
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
