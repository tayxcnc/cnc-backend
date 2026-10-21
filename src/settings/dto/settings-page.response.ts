import { ApiProperty } from '@nestjs/swagger';
import { OpeningHoursResponse } from './opening-hours.dto';
import { BusinessResponse, SettingsResponse } from './settings.response';

/**
 * `GET /staff/settings`: everything the Settings screen edits, each part
 * with its own `version` for its own save route.
 */
export class SettingsPageResponse {
  @ApiProperty({ type: SettingsResponse })
  settings!: SettingsResponse;

  @ApiProperty({ type: BusinessResponse })
  business!: BusinessResponse;

  @ApiProperty({ type: OpeningHoursResponse })
  openingHours!: OpeningHoursResponse;
}
