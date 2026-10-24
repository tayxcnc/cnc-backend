# The staff demo's 107 domain tests, mapped to the backend specs

The Backend Brief's first acceptance line is "All 107 staff domain tests
pass against the server rules, including owner.test.cjs". The plan (§11,
§15 C8-6) restates it: the 107 tests pass as the ported e2e and report
specs. This file maps each of them to the spec that runs it.

**The 107** are the nine suites the staff app had when the plan was
written (`cnc-frontend/staff/tests`, unchanged since): `domain` 34,
`overview` 5, `revision` 16, `attendance` 6, `ux` 10, `exports` 3,
`payments` 7, `stock` 10, `owner` 16, counted by running
`node --test` on each. The staff app's later `api-*` suites test its own
API client and are not part of the 107.

**How to read a row.** The backend test named in the last column holds the
demo test's expectations through HTTP and Postgres. Where a demo test's
assertions are split across two or three backend tests (one command each),
all of them are listed, joined by `+`. Most ported tests keep the demo's
title word for word.

**Ten have no server counterpart.** Four stay in the staff app's own
suite (`staff app only`): one `ux.test.cjs` test of a screen choice kept in
the browser, and the three `exports.test.cjs` tests of the CSV and PDF
files, which the staff app builds from the API's rows (A20). Six
`ux.test.cjs` tests of the demo's browser storage (saved workspaces,
quota, migration and recovery of `localStorage`) are `retired with the
demo store (C8-5)`: the staff app removed that store and its tests with it
(cnc-frontend `3e5c18b`), so no suite runs them. The server has no browser
storage to test, and the rules those screens guard (the locations and
reports a role may use) are refused by the API itself and tested there.

*Departure from plan §14 item 7, recorded for the founder:* the plan kept
the 107 as the staff app's own unit tests while `domain.ts` validated
commands in the browser. From C8-5 `domain.ts` no longer runs commands, so
the staff app kept only the tests of the helpers its screens still use
(13), and the server's tests named here are the record.

**Where the server deliberately differs**, the backend test asserts the
server's rule, as the plan decided:
- the demo's `clock.tick` and its client clock are gone (A11), so "a hold
  never marks a no show by itself" is asserted against the server's time;
- deposits are kept at zero and no route sets one (D38), so the deposit
  half of the payment chart test is the legacy settle-credit port;
- "an old state without the setting still works" has no server meaning:
  every setting is a column with a default, so there is no old state;
- card refunds go through Paystack (Q26) where the demo recorded Cash;
- the overview splits departments by line (D30), which equals the demo
  for every till bill.

`test/c8-acceptance.e2e-spec.ts` (line 1) reads this table: it requires
107 rows with the counts above, and that every named spec exists and holds
every named test title, so a renamed or removed test fails the acceptance
run.

| Suite | Demo test | Backend spec | Backend test |
| :--- | :--- | :--- | :--- |
| `domain.test.cjs` | supplied floor plans and complete food menu are retained | `test/seed.e2e-spec.ts` | "seeds two rooms with 23 tables and 58 places" + "seeds the 166 items as built: 79 Restaurant, 87 Bar, 11 with a choice, prices in kobo" |
| `domain.test.cjs` | restaurant and bar keep independent sequential references | `test/orders.e2e-spec.ts` | "restaurant and bar keep independent sequential references" |
| `domain.test.cjs` | bar edits and payment handoff do not deduct stock; settlement deducts once | `test/order-payments.e2e-spec.ts` | "bar edits and payment handoff do not deduct stock; settlement deducts once" |
| `domain.test.cjs` | payment handoff locks items until manager reopens with a reason | `test/order-payments.e2e-spec.ts` | "payment handoff locks items until manager reopens with a reason" |
| `domain.test.cjs` | cash or transfer validation failures are atomic | `test/order-payments.e2e-spec.ts` | "cash or transfer validation failures are atomic" |
| `domain.test.cjs` | insufficient bar stock prevents both payment and sale completion | `test/order-payments.e2e-spec.ts` | "insufficient bar stock prevents both payment and sale completion" |
| `domain.test.cjs` | midnight uses Lagos time and freezes yesterday items while allowing settlement | `test/c4-demo-ports.e2e-spec.ts` | "midnight uses Lagos time and freezes yesterday items while allowing settlement" |
| `domain.test.cjs` | food confirm creates immutable full-list docket revisions without kitchen deduction | `test/orders.e2e-spec.ts` | "food confirm creates immutable full-list docket revisions without kitchen deduction" |
| `domain.test.cjs` | unconfirmed food changes cannot proceed to payment | `test/order-payments.e2e-spec.ts` | "unconfirmed food changes cannot proceed to payment" |
| `domain.test.cjs` | kitchen correction returns only removed portions, and can clear a cancelled docket | `test/kitchen.e2e-spec.ts` | "kitchen correction returns only removed portions, and can clear a cancelled docket" |
| `domain.test.cjs` | duplicate manual kitchen docket is rejected | `test/kitchen.e2e-spec.ts` | "duplicate manual kitchen docket is rejected" |
| `domain.test.cjs` | closed kitchen day and previous dates require logged manager corrections | `test/kitchen.e2e-spec.ts` | "closes the current day only, once, and a closed day needs logged manager corrections" + "a previous day’s docket needs a manager’s correction with a reason" |
| `domain.test.cjs` | food settlement never repeats a kitchen deduction | `test/order-payments.e2e-spec.ts` | "food settlement never repeats a kitchen deduction" |
| `domain.test.cjs` | cancelling confirmed food returns a cancellation docket, leaving manual kitchen work independent | `test/order-payments.e2e-spec.ts` | "cancelling confirmed food returns a cancellation docket, leaving manual kitchen work independent" |
| `domain.test.cjs` | legacy deposit credit cannot be reused across restaurant and bar orders | `test/order-payments.e2e-spec.ts` | "legacy deposit credit cannot be reused across restaurant and bar orders" |
| `domain.test.cjs` | settlement reversal restores bar stock and cannot be applied twice | `test/order-payments.e2e-spec.ts` | "settlement reversal restores bar stock and cannot be applied twice" |
| `domain.test.cjs` | stock request partial issues convert store packs and complete once | `test/stock-requests.e2e-spec.ts` | "stock request partial issues convert store packs and complete once" |
| `domain.test.cjs` | purchases require manager approval before one-time receiving | `test/purchasing.e2e-spec.ts` | "purchases require manager approval before one-time receiving" |
| `domain.test.cjs` | pending waste does not deduct; approved waste deducts once | `test/waste.e2e-spec.ts` | "pending waste does not deduct; approved waste deducts once" |
| `domain.test.cjs` | paid seating stays occupied until reception manually releases it | `test/reception.e2e-spec.ts` | "paid seating stays occupied until reception manually releases it" |
| `domain.test.cjs` | audit snapshots survive later order changes without mutation | `test/c4-demo-ports.e2e-spec.ts` | "audit snapshots survive later order changes without mutation" |
| `domain.test.cjs` | crosscheck distinguishes missing, revision and quantity mismatches | `test/kitchen.e2e-spec.ts` | "crosscheck distinguishes missing, revision and quantity mismatches" |
| `domain.test.cjs` | staff permissions block kitchen payment and waiter stock adjustments | `test/c4-demo-ports.e2e-spec.ts` | "staff permissions block kitchen payment and waiter stock adjustments" |
| `domain.test.cjs` | cancelling a reservation before arrival takes no deposit and records no refund | `test/reception.e2e-spec.ts` | "cancelling a reservation before arrival takes no deposit and records no refund" |
| `domain.test.cjs` | a hold never marks a no show by itself; staff mark it after the booking time; occupied seating never expires | `test/reception.e2e-spec.ts` | "a hold never marks a no show by itself; staff mark it after the booking time" + "paid seating stays occupied until reception manually releases it" |
| `domain.test.cjs` | settings default to the agreed delivery fees, no deposit and a 3 hour hold | `test/c4-demo-ports.e2e-spec.ts` | "settings default to the agreed delivery fees, no deposit and a 3 hour hold" |
| `domain.test.cjs` | a booking keeps its table for the whole date until staff free it | `test/reception.e2e-spec.ts` | "a booking keeps its table for the whole date until staff free it" |
| `domain.test.cjs` | check in stays open for the whole booking date | `test/reception.e2e-spec.ts` | "check in stays open for the whole booking date" |
| `domain.test.cjs` | split settlement records exact component amounts | `test/order-payments.e2e-spec.ts` | "split settlement records exact component amounts" |
| `domain.test.cjs` | a carried order may confirm its frozen items after midnight and then pay | `test/orders.e2e-spec.ts`, `test/c4-demo-ports.e2e-spec.ts` | "a carried order may confirm its frozen items after midnight, under its own date" + "midnight uses Lagos time and freezes yesterday items while allowing settlement" |
| `domain.test.cjs` | a purchase retains the selected vendor for every line | `test/purchasing.e2e-spec.ts` | "a purchase retains the selected vendor for every line" |
| `domain.test.cjs` | new portions begin at zero; unit changes preserve receiving quantity through a ledger movement | `test/c4-demo-ports.e2e-spec.ts` | "new portions begin at zero; unit changes preserve receiving quantity through a ledger movement" |
| `domain.test.cjs` | task edits retain identity and maintenance links | `test/tasks.e2e-spec.ts` | "task edits retain identity and maintenance links" |
| `domain.test.cjs` | dishes with options need one, keep each choice as its own line and print it on the docket | `test/orders.e2e-spec.ts` | "dishes with options need one, keep each choice as its own line and print it on the docket" |
| `overview.test.cjs` | overview excludes unpaid and reversed sales and uses Lagos settlement dates | `test/overview.e2e-spec.ts` | "gives a manager every widget of their layout, with exact figures" + "files a sale by its Lagos settlement date and counts payments dated in the range" |
| `overview.test.cjs` | payment chart retains delivery fees and split receipts without counting deposit credit twice | `test/overview.e2e-spec.ts` | "files a sale by its Lagos settlement date and counts payments dated in the range" + "gives a manager every widget of their layout, with exact figures" |
| `overview.test.cjs` | overview calendar ranges start on Monday and reject invalid or backwards dates | `src/shell/overview-preferences.spec.ts`, `test/overview.e2e-spec.ts` | "builds the presets as the demo does" + "accepts real dates only (the demo’s validDate)" + "refuses a bad range in the reports’ words" |
| `overview.test.cjs` | damaged saved layouts recover without duplicate or unknown widgets | `src/shell/overview-preferences.spec.ts` | "recovers a damaged saved layout without duplicate or unknown widgets" |
| `overview.test.cjs` | monthly sales buckets reconcile with totals across a long date range | `test/overview.e2e-spec.ts` | "is hourly for one day, daily up to 62 days and monthly at 63" |
| `revision.test.cjs` | an empty generated bill survives and only a manager may cancel it | `test/order-payments.e2e-spec.ts` | "an empty generated bill survives and only a manager may cancel it" |
| `revision.test.cjs` | kitchen derives order date and newest revision from one docket number | `test/kitchen.e2e-spec.ts` | "kitchen derives order date and newest revision from one docket number" |
| `revision.test.cjs` | manager kitchen date correction always requires a reason | `test/kitchen.e2e-spec.ts` | "manager kitchen date correction always requires a reason" |
| `revision.test.cjs` | received purchase correction changes only stock difference and archive retains receipt | `test/purchasing.e2e-spec.ts` | "received purchase correction changes only stock difference and archive retains receipt" |
| `revision.test.cjs` | approved waste corrections and rejection restore exact quantities | `test/waste.e2e-spec.ts` | "approved waste corrections and rejection restore exact quantities" |
| `revision.test.cjs` | assigned staff may save task status but cannot change assignment or record links | `test/tasks.e2e-spec.ts` | "assigned staff may save task status but cannot change assignment or record links" |
| `revision.test.cjs` | purchase tasks must link an open requisition | `test/tasks.e2e-spec.ts` | "purchase tasks must link an open requisition" |
| `revision.test.cjs` | online item edit preserves original payment and completion waits for refund | `test/online-orders-staff.e2e-spec.ts` | "edits a paid order down, moves the Bar, refunds through Paystack once, then completes" |
| `revision.test.cjs` | online cancellation keeps the full refund obligation and manager history | `test/online-orders-staff.e2e-spec.ts` | "cancels, returns the drinks and sends the kitchen a cancellation docket; the refund goes to the card" |
| `revision.test.cjs` | cashier advances online status while manager can correct fulfilment with a reason | `test/online-orders-staff.e2e-spec.ts` | "lets the Cashier move one stage at a time to Delivered (gate step 3)" + "lets a manager correct the stage backwards with a reason, never across modes" |
| `revision.test.cjs` | QR scans reject invalid and unauthorised scans and ignore duplicates | `test/attendance.e2e-spec.ts` | "QR scans reject invalid and unauthorised scans and ignore duplicates" |
| `revision.test.cjs` | overnight QR departure closes the original shift and the next arrival creates another | `test/attendance.e2e-spec.ts` | "overnight QR departure closes the original shift and the next arrival creates another" |
| `revision.test.cjs` | attendance corrections retain original times and reject overlapping shifts | `test/attendance.e2e-spec.ts` | "attendance corrections retain original times and reject overlapping shifts" |
| `revision.test.cjs` | email changes preserve QR and staff ID, increment session version and cannot reuse another email | `test/staff-demo-ports.e2e-spec.ts` | "email changes preserve QR and staff ID, increment session version and cannot reuse another email" |
| `revision.test.cjs` | staff can change only their own photo and photographs do not bloat audit snapshots | `test/staff-demo-ports.e2e-spec.ts` | "staff can change only their own photo and photographs do not bloat audit snapshots" |
| `revision.test.cjs` | existing demo records migrate once without replacing staff identities or attendance | `test/staff-demo-ports.e2e-spec.ts` | "existing demo records migrate once without replacing staff identities or attendance" |
| `attendance.test.cjs` | attendance management is restricted to the manager and owner, and every staff role retains personal ID access | `test/attendance.e2e-spec.ts` | "attendance management is restricted to the manager and owner, and every staff role retains personal ID access" |
| `attendance.test.cjs` | individual reports isolate the staff identity and use inclusive arrival dates for overnight shifts | `test/attendance.e2e-spec.ts` | "individual reports isolate the staff identity and use inclusive arrival dates for overnight shifts" |
| `attendance.test.cjs` | payroll summary counts arrival days once and never estimates hours for open shifts | `src/attendance/attendance-rules.spec.ts` | "payroll summary counts arrival days once and never estimates hours for open shifts" |
| `attendance.test.cjs` | date ranges reject invalid or reversed dates and month boundaries include leap years | `src/attendance/attendance-rules.spec.ts` | "date ranges reject invalid or reversed dates and month boundaries include leap years" |
| `attendance.test.cjs` | manager bell contains pending approvals and removes each when it is resolved | `test/approvals.e2e-spec.ts` | "manager bell contains pending approvals and removes each when it is resolved" |
| `attendance.test.cjs` | staff notifications are relevant to the role and assigned tasks disappear when done | `test/staff-bell.e2e-spec.ts`, `test/tasks.e2e-spec.ts` | "%s gets exactly its items, in the demo’s order and words" + "staff notifications are relevant to the role and assigned tasks disappear when done" |
| `ux.test.cjs` | required choices and whitespace report actionable field errors while optional choices remain optional | `test/staff-demo-ports.e2e-spec.ts` | "required choices and whitespace report actionable field errors while optional choices remain optional" |
| `ux.test.cjs` | numeric fields accept required zero and valid fractional steps while rejecting out of range, nonfinite and fractional portion counts | `test/staff-demo-ports.e2e-spec.ts` | "numeric fields accept required zero and valid fractional steps while rejecting out of range, nonfinite and fractional portion counts" |
| `ux.test.cjs` | saved demo workspace round trips without losing bill history and absent data alone seeds samples | retired with the demo store (C8-5) | browser storage of the demo workspace; the server keeps the records |
| `ux.test.cjs` | corrupt, unsupported and incomplete saved records fail visibly instead of resetting silently | retired with the demo store (C8-5) | browser storage of the demo workspace |
| `ux.test.cjs` | a failed command keeps persisted records untouched and cannot approve under an unauthorised role | `test/staff-demo-ports.e2e-spec.ts` | "a failed command keeps persisted records untouched and cannot approve under an unauthorised role" |
| `ux.test.cjs` | saved manager choices cannot expose forbidden inventory locations or report types after a role change | staff app only | a screen choice kept in the browser; the server refuses the location or report itself |
| `ux.test.cjs` | healthy saved records remain readable without a write when the storage quota is exhausted | retired with the demo store (C8-5) | browser storage quota |
| `ux.test.cjs` | legacy migration persists once and a rejected migration write preserves the original bytes | retired with the demo store (C8-5) | browser storage migration |
| `ux.test.cjs` | incomplete or duplicate staff identities and malformed nested records require recovery without writes | retired with the demo store (C8-5) | browser storage recovery |
| `ux.test.cjs` | missing existing records and denied reads cannot silently initialise or replace saved data | retired with the demo store (C8-5) | browser storage reads |
| `exports.test.cjs` | CSV keeps negative quantities numeric, escapes unsafe text, quotes delimiters and leaves missing values blank | staff app only | the staff app builds CSV from the API’s rows (A20) |
| `exports.test.cjs` | attendance PDFs paginate an oversized row into valid pages | staff app only | the staff app builds the PDF from the API’s rows (A20) |
| `exports.test.cjs` | empty attendance periods still produce a valid one-page PDF | staff app only | the staff app builds the PDF from the API’s rows (A20) |
| `payments.test.cjs` | a part payment keeps the bill in Payment and lowers the balance | `test/order-payments.e2e-spec.ts` | "a part payment keeps the bill in Payment and lowers the balance" |
| `payments.test.cjs` | part payments work for card, transfer and split | `test/order-payments.e2e-spec.ts` | "part payments work for card, transfer and split" |
| `payments.test.cjs` | a part payment must be less than the balance | `test/order-payments.e2e-spec.ts` | "a part payment must be less than the balance" |
| `payments.test.cjs` | settlement takes only the remaining balance after part payments | `test/order-payments.e2e-spec.ts` | "settlement takes only the remaining balance after part payments" |
| `payments.test.cjs` | only cashiers, bartenders and managers take part payments | `test/order-payments.e2e-spec.ts` | "only cashiers, bartenders and managers take part payments" |
| `payments.test.cjs` | a part paid bill cannot be cancelled | `test/order-payments.e2e-spec.ts` | "a part paid bill cannot be cancelled" |
| `payments.test.cjs` | settings keep business details and printer width | `test/settings.e2e-spec.ts` | "lets a manager change the printer and an alert, and moves the version" + "never lets the name, the address or the phone end up blank" + "answers out-of-range values in the demo’s words" |
| `stock.test.cjs` | kitchen requests whole purchase units and the store issues them as portions | `test/stock-requests.e2e-spec.ts` | "kitchen requests whole purchase units and the store issues them as portions" |
| `stock.test.cjs` | the storekeeper can issue directly to the bar in whole units | `test/c4-demo-ports.e2e-spec.ts` | "the storekeeper can issue directly to the bar in whole units" |
| `stock.test.cjs` | stock count records only the differences, in whole numbers | `test/stock.e2e-spec.ts` | "stock count records only the differences, in whole numbers" |
| `stock.test.cjs` | correct balance takes Add or Remove, a whole number and a reason | `test/stock.e2e-spec.ts` | "correct balance takes Add or Remove, a whole number and a reason" |
| `stock.test.cjs` | waste must be a whole quantity | `src/waste/waste-rules.spec.ts` | "waste must be a whole quantity" |
| `stock.test.cjs` | reception must record a guest email for a reservation | `test/reception.e2e-spec.ts` | "reception must record a guest email for a reservation" |
| `stock.test.cjs` | a purchase raises a review task for the manager, then a receive task for the store, and both close | `test/purchasing.e2e-spec.ts` | "a purchase raises a review task for the manager, then a receive task for the store, and both close" |
| `stock.test.cjs` | a new repair raises a task for the manager that closes when fixed | `test/assets-maintenance.e2e-spec.ts` | "a new repair raises a task for the manager that closes when fixed" |
| `stock.test.cjs` | staff can raise a task to a manager or themselves, not to other staff | `test/tasks.e2e-spec.ts` | "staff can raise a task to a manager or themselves, not to other staff" |
| `stock.test.cjs` | waiters and bartenders have no tasks; cashiers can request bar stock, log bar waste and raise tasks | `test/tasks.e2e-spec.ts`, `test/stock-requests.e2e-spec.ts`, `test/waste.e2e-spec.ts` | "waiters and bartenders have no tasks; cashiers can raise tasks" + "cashiers can request bar stock, and only bar stock" + "refuses in the demo’s order: the location, the role’s own location, the quantity and reason, then the item" |
| `owner.test.cjs` | the Owner Approval Limit defaults to 50,000 naira and old saved records fall back to it | `test/staff-demo-ports.e2e-spec.ts` | "the Owner Approval Limit defaults to 50,000 naira and old saved records fall back to it" |
| `owner.test.cjs` | only the Owner reverses a paid bill | `test/order-payments.e2e-spec.ts` | "only the Owner reverses a paid bill" |
| `owner.test.cjs` | only the Owner corrects a stock balance | `test/stock.e2e-spec.ts` | "only the Owner corrects a stock balance" |
| `owner.test.cjs` | a manager cannot set or change a price or add an item, but can still edit everything else | `test/staff-demo-ports.e2e-spec.ts` | "a manager cannot set or change a price or add an item, but can still edit everything else" |
| `owner.test.cjs` | a manager keeps printer, alerts and the free table reminder but not tax, delivery or the limit | `test/staff-demo-ports.e2e-spec.ts` | "a manager keeps printer, alerts and the free table reminder but not tax, delivery or the limit" |
| `owner.test.cjs` | discounts above the limit need the Owner; a lowered limit applies at once | `test/c4-demo-ports.e2e-spec.ts` | "discounts above the limit need the Owner; a lowered limit applies at once" |
| `owner.test.cjs` | purchases above the limit need the Owner and nobody but the Owner approves their own | `test/purchasing.e2e-spec.ts` | "purchases above the limit need the Owner and nobody but the Owner approves their own" |
| `owner.test.cjs` | a manager cannot approve their own purchase even by another route, but may reject it; the Owner may approve it | `test/purchasing.e2e-spec.ts` | "a manager cannot approve their own purchase even by another route, but may reject it; the Owner may approve it" |
| `owner.test.cjs` | waste write-offs above the limit need the Owner, and managers cannot approve waste they logged | `test/waste.e2e-spec.ts` | "waste write-offs above the limit need the Owner, and managers cannot approve waste they logged" |
| `owner.test.cjs` | a manager cannot issue a stock request they raised | `test/stock-requests.e2e-spec.ts` | "a manager cannot issue a stock request they raised" |
| `owner.test.cjs` | online payment corrections above the limit need the Owner | `test/online-orders-staff.e2e-spec.ts` | "sends a change or a refund above the Owner Approval Limit to the Owner, who is never counted" |
| `owner.test.cjs` | only the Owner creates or changes Manager and Owner accounts, and one Owner always remains | `test/staff-demo-ports.e2e-spec.ts` | "only the Owner creates or changes Manager and Owner accounts, and one Owner always remains" |
| `owner.test.cjs` | managers see their own actions and the Owner and staff actions, never another manager’s; the Owner sees all | `test/staff-demo-ports.e2e-spec.ts` | "managers see their own actions and the Owner and staff actions, never another manager’s; the Owner sees all" |
| `owner.test.cjs` | history is append only: no command edits or removes an audit entry | `test/staff-demo-ports.e2e-spec.ts` | "history is append only: no command edits or removes an audit entry" |
| `owner.test.cjs` | the Daily Approval Limit caps one manager across decisions, is on by default, and only the Owner changes it | `test/staff-demo-ports.e2e-spec.ts` | "the Daily Approval Limit caps one manager across decisions, is on by default, and only the Owner changes it" |
| `owner.test.cjs` | the daily total starts fresh each business day, and an old state without the setting still works | `test/money-control.e2e-spec.ts` | "starts the total fresh on the next business date" |
