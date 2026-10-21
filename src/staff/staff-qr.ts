/**
 * What a staff ID's QR code encodes: `CNC-ID:<staff number>:<qrToken>`.
 *
 * The staff app's own format (`staff/lib/staff.ts`, `staffCode`), where the
 * staff id was the staff number (`CNC-S001`). Kept so the codes the app
 * printed and its scanner read stay one shape; the attendance scan (C5-7)
 * parses this and nothing else.
 *
 * The prefix lets the scan refuse at once a code that is not a CNC staff ID
 * (a TAY member's door code, a menu link). The token is the credential: it
 * is rendered into the picture by `renderQrSvg` and never sent as text.
 */
export const STAFF_QR_PREFIX = 'CNC-ID:';

export function staffQrPayload(staffNo: string, qrToken: string): string {
  return `${STAFF_QR_PREFIX}${staffNo}:${qrToken}`;
}
