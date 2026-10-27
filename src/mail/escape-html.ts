/**
 * Escape text for interpolation into an HTML email body, copied from TAY's
 * `escapeHtml`.
 *
 * Every caller-supplied value that reaches a mail body goes through this. A
 * customer's name is chosen by the person it belongs to and constrained by
 * nothing beyond "not blank", and a name containing a tag would otherwise be
 * injected into mail CNC sends on that person's behalf.
 *
 * One copy, beside the mail frame, because two escapers is how one of them
 * quietly stops matching the other.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
