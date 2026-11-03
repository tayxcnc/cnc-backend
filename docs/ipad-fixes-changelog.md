# iPad fixes changelog: CNC backend (cnc-backend)

What each fix from the iPad fix pack and its batch 2 brief changed in this
repository, and every decision taken without the founder's confirmation.
Newest entries go at the top.

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
  the old number appears in any spelling: with spaces, hyphens, brackets,
  dots, `0`, `234` or `+234`, or split across a comment's line. The old
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
