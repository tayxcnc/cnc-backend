import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PublicCache } from '../common/public-cache';
import { PublicMenuResponse } from './dto/public-menu.response';
import { MenuService } from './menu.service';

/**
 * The public menu (plan §5.1, C6-4): `/menus` (every tab), `/order` and the
 * account's menu. No sign-in, cached for a minute, and nothing internal.
 */
@ApiTags('Public')
@Controller('menu')
export class PublicMenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  @PublicCache()
  @ApiOperation({
    operationId: 'getMenu',
    summary: 'The menu the website shows',
    description:
      'Every dish that is Available for Sale and Show Online, by customer ' +
      'category, with its price in kobo, group, choice, and photo and ' +
      'thumbnail links valid for at least 45 minutes. An unavailable dish ' +
      'is left out (Q37). Public; cached for a minute, with an `ETag` ' +
      '(`If-None-Match` answers 304 while nothing changed) and compressed ' +
      'for a client that asks.',
  })
  @ApiResponse({ status: 200, type: PublicMenuResponse })
  menuRead(): Promise<PublicMenuResponse> {
    return this.menu.publicMenu();
  }
}
