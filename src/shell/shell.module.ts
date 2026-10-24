import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ImagesModule } from '../images/images.module';
import { MenuModule } from '../menu/menu.module';
import { SettingsModule } from '../settings/settings.module';
import { StaffModule } from '../staff/staff.module';
import { ShellController } from './shell.controller';
import { ShellService } from './shell.service';

/**
 * The staff app's shell (card C3-8): `GET /staff/me`, `GET /staff/reference`
 * and the overview layout. It reads through the settings and menu services,
 * so the reference data comes back in exactly the shapes their own routes
 * answer. `GET /staff/overview` itself is `OverviewModule`'s.
 */
@Module({
  imports: [
    CncAuthModule,
    ImagesModule,
    SettingsModule,
    MenuModule,
    StaffModule,
  ],
  controllers: [ShellController],
  providers: [ShellService],
  // The overview (C8-1) reads a manager's layout through it.
  exports: [ShellService],
})
export class ShellModule {}
