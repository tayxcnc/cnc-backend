import { Injectable, NotFoundException } from '@nestjs/common';
import { STAFF_NOT_FOUND_MESSAGE } from '../auth/staff-auth.service';
import { formatIsoDate } from '../common/calendar-date';
import { renderQrSvg } from '../common/qr-svg';
import { PhotoStore } from '../images/photo-store.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type { StaffCardResponse } from './dto/staff-card.response';
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

  async card(staffId: string): Promise<StaffCardResponse> {
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
}
