/**
 * An id field as sent: a non-blank string, or undefined for anything else
 * (absent, null, blank, not text).
 *
 * A command whose demo sentence covers a missing record and an unknown one
 * alike ("Select an asset and vendor.", "Choose an active vendor for every
 * line.") reads its ids through this, then looks the record up: undefined
 * answers the same sentence as a lookup that finds nothing. Shared in
 * `src/common` because tasks, repairs and purchase lines all ask it, and
 * one copy keeps them agreeing on what counts as sent (*Reuse*).
 */
export function sentId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
