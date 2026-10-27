/**
 * What the staff app's Print buttons print, and the sentences the print
 * record answers (plan §5.3 `POST /staff/audit/print`, A19).
 *
 * The documents are the staff app's own names, as its `print` command
 * sends them: the print dialog's kinds (`components/cnc/print.tsx`), the
 * attendance report and a report's CSV export. The demo accepted any text;
 * the server keeps the log to the documents a screen can print, so a row
 * names something a reader recognises.
 */
export const PRINT_DOCUMENTS = [
  'docket',
  'bill',
  'receipt',
  'purchase',
  'staff',
  'attendance',
  'CSV export',
] as const;

export type PrintDocument = (typeof PRINT_DOCUMENTS)[number];

/** New with the server: the demo did not check the document. */
export const PRINT_DOCUMENT_MESSAGE = 'Choose a document to print.';

/** New with the server: the demo did not check the ref. */
export const PRINT_REF_MESSAGE = 'Name the record printed.';

/** The longest ref a print records: a CSV export's report title fits. */
export const PRINT_REF_MAX_LENGTH = 120;

/** New with the server: a docket's revision is a whole number from 1. */
export const PRINT_REVISION_MESSAGE = 'Enter a valid docket revision.';

/** New with the server: an attendance print's period is two dates. */
export const PRINT_PERIOD_MESSAGE = 'Enter a valid print period.';
