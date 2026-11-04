import { Injectable, NotFoundException } from '@nestjs/common';
import type { StaffRole } from '../../generated/cnc-client';
import { STAFF_NOT_FOUND_MESSAGE } from '../auth/staff-auth.service';
import { formatIsoDate } from '../common/calendar-date';
import { renderQrSvg } from '../common/qr-svg';
import { PhotoStore } from '../images/photo-store.service';
import type { StoredPhoto } from '../images/photo-store.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type { StaffCardResponse } from './dto/staff-card.response';
import { NO_STAFF_PHOTO_MESSAGE } from './staff-messages';
import { staffQrPayload } from './staff-qr';

/**
 * Staff ID cards (plan §5.3 `GET /staff/me/card`, §5.4 `GET /staff/people/
 * :id/card`). Who may read which card is the controllers' rule; this reads
 * and renders.
 *
 * The one read outside the QR reissue that selects `qrToken`, and it does so
 * only to hand it to `renderQrSvg`. The token is in no field of the answer.
 */
@Injectable()
export class StaffCardService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly photos: PhotoStore,
  ) {}

  /**
   * `authorise` is the controller's rule on whose card the caller may read,
   * given the account's id and role. It runs after the row is found and
   * before anything is rendered or signed.
   */
  async card(
    staffId: string,
    authorise?: (account: { id: string; role: StaffRole }) => void,
  ): Promise<StaffCardResponse> {
    const row = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        staffNo: true,
        name: true,
        role: true,
        isActive: true,
        email: true,
        photo: true,
        joinedOn: true,
        qrToken: true,
      },
    });

    if (row === null) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);

    authorise?.({ id: row.id, role: row.role });

    return {
      id: row.id,
      staffNo: row.staffNo,
      name: row.name,
      role: row.role,
      isActive: row.isActive,
      email: row.email,
      photoUrl: await this.photos.signedUrlOrNull(row.photo),
      joinedOn: formatIsoDate(row.joinedOn),
      qrSvg: await renderQrSvg(staffQrPayload(row.staffNo, row.qrToken)),
    };
  }

  /**
   * The card's photograph as bytes (CS B5), for a screen that draws the
   * card into a canvas or a PDF and so cannot use the signed link: the
   * bucket has no CORS policy, and a canvas refuses a cross-origin image
   * without one.
   *
   * `authorise` is the card's own rule, run at the same point, so the photo
   * is never readable by anyone who could not read the card. 404 with
   * {@link NO_STAFF_PHOTO_MESSAGE} when there is no photo, or the one
   * recorded is no longer in the bucket.
   */
  async photo(
    staffId: string,
    authorise?: (account: { id: string; role: StaffRole }) => void,
  ): Promise<StoredPhoto> {
    const row = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: { id: true, role: true, photo: true },
    });

    if (row === null) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);

    authorise?.({ id: row.id, role: row.role });

    const stored = await this.photos.read(row.photo);

    if (stored === null) throw new NotFoundException(NO_STAFF_PHOTO_MESSAGE);

    return stored;
  }
}
