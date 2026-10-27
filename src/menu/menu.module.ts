import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ImagesModule } from '../images/images.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { PublicMenuController } from './public-menu.controller';

/**
 * Menu & Prices (card C3-7), and the public `GET /menu` (C6-4). `MenuService` is exported for the staff
 * shell's `GET /staff/reference` (C3-8), which answers the menu in the same
 * shape. `IdempotencyService` arrives through its global module.
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule, ImagesModule],
  controllers: [MenuController, PublicMenuController],
  providers: [MenuService],
  exports: [MenuService],
})
export class MenuModule {}
