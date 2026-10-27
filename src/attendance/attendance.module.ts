import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ImagesModule } from '../images/images.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

/**
 * Attendance (card C5-7): the QR scan, the correction and the reads.
 * `ImagesModule` signs the photographs the scanner and the directory show.
 * No `AuditRefAccess` reader is registered: plan §4.8 gives no
 * non-manager an attendance history, so the registry's fail-closed answer
 * is the rule.
 */
@Module({
  imports: [CncAuthModule, AuditModule, ImagesModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
})
export class AttendanceModule {}
