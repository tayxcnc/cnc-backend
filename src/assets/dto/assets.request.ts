import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsEnum,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AssetStatus, MaintenanceStatus } from '../../../generated/cnc-client';
import { REASON_MAX_LENGTH } from '../../common/admin-reason';
import { PaginationQuery } from '../../common/dto/pagination.query';
import {
  VERSION_FIELD_MESSAGE,
  VersionedWriteDto,
} from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import {
  ASSET_STATUS_MESSAGE,
  ASSET_TEXT_MAX_LENGTH,
  REPAIR_DESCRIPTION_MAX_LENGTH,
  REPAIR_STATUS_FILTER_MESSAGE,
} from '../asset-messages';

/**
 * Each field answers one sentence at most (`Checked`, a single
 * class-validator decorator), so the demo's sentence reaches the screen
 * once (A7). The fields the demo checks together in one sentence ("Enter a
 * tag, name and quantity.", "Select an asset and vendor.", "Enter a
 * description and valid cost.") are admitted here (`@Allow()`) and judged
 * in the service, in the demo's order.
 */

const Search = () =>
  applyDecorators(
    Transform(({ value }) => trimText(value)),
    ValidateIf(isSent),
    IsString({ message: 'q must be text.' }),
    MaxLength(120, { message: 'q must be 120 characters or fewer.' }),
  );

/**
 * Body of `PUT /staff/assets/:tag`: `asset.save`, managers. With no
 * `version` it adds the asset under the tag; with one it replaces the
 * asset the tag names, as the client read it.
 */
export class SaveAssetRequest {
  @ApiProperty({
    type: String,
    maxLength: ASSET_TEXT_MAX_LENGTH,
    example: 'Lounge air conditioner',
  })
  @Allow()
  name!: unknown;

  @ApiProperty({
    type: Number,
    minimum: 1,
    example: 1,
    description:
      'Checked with the tag and name: "Enter a tag, name and quantity."',
  })
  @Allow()
  quantity!: unknown;

  @ApiPropertyOptional({
    maxLength: ASSET_TEXT_MAX_LENGTH,
    example: 'Cooling',
    description: 'Empty when left out.',
  })
  @OptionalText('category', ASSET_TEXT_MAX_LENGTH)
  category?: string;

  @ApiPropertyOptional({
    maxLength: ASSET_TEXT_MAX_LENGTH,
    example: 'Lounge',
    description: 'Where it is. Empty when left out.',
  })
  @OptionalText('location', ASSET_TEXT_MAX_LENGTH)
  location?: string;

  @ApiPropertyOptional({
    enum: AssetStatus,
    enumName: 'AssetStatus',
    description:
      'A new asset is Active when this is left out; an existing one keeps ' +
      'its status unless this is sent. Repairs move it too.',
  })
  @ValidateIf(isSent)
  @IsEnum(AssetStatus, { message: ASSET_STATUS_MESSAGE })
  status?: AssetStatus;

  @ApiPropertyOptional({
    description:
      'Left out to add a new asset under the tag (409 "This asset tag ' +
      'already exists." when one holds it). Sent to change the asset the ' +
      'tag names: the `version` it was read at, refused with 409 "This ' +
      'record changed. Refresh and try again." when stale.',
    minimum: 0,
    example: 0,
  })
  @ValidateIf(isSent)
  @IsInt({ message: VERSION_FIELD_MESSAGE })
  @Min(0, { message: VERSION_FIELD_MESSAGE })
  version?: number;
}

/** `GET /staff/assets`. */
export class AssetsQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: AssetStatus, enumName: 'AssetStatus' })
  @ValidateIf(isSent)
  @IsEnum(AssetStatus, { message: ASSET_STATUS_MESSAGE })
  status?: AssetStatus;

  @ApiPropertyOptional({
    description: 'Part of a tag, name, category or location, any case.',
  })
  @Search()
  q?: string;
}

/** The fields of `maintenance.save`, on a new repair and an update alike. */
const RepairFields = {
  assetId: () =>
    applyDecorators(
      ApiProperty({
        type: String,
        description:
          'Asset.id. Checked with the vendor: "Select an asset and vendor."',
      }),
      Allow(),
    ),
  vendorId: () =>
    applyDecorators(
      ApiProperty({ type: String, description: 'Vendor.id.' }),
      Allow(),
    ),
  description: () =>
    applyDecorators(
      ApiProperty({
        type: String,
        maxLength: REPAIR_DESCRIPTION_MAX_LENGTH,
        description:
          'The problem or the work. Checked with the cost: "Enter a ' +
          'description and valid cost."',
        example: 'Screen flickers',
      }),
      Allow(),
    ),
  costKobo: () =>
    applyDecorators(
      ApiProperty({
        type: Number,
        minimum: 0,
        description: 'What the repair cost, in kobo; 0 when nothing yet.',
        example: 0,
      }),
      Allow(),
    ),
  status: () =>
    applyDecorators(
      ApiProperty({
        enum: MaintenanceStatus,
        enumName: 'MaintenanceStatus',
        description: 'Refused with "Invalid repair status."',
      }),
      Allow(),
    ),
  taskId: () =>
    applyDecorators(
      ApiPropertyOptional({
        type: String,
        description:
          'Task.id: an existing task this repair is the work for. It is ' +
          'linked, becomes a Maintenance task and moves to In Progress, and ' +
          'no follow-up task is raised. A task that already has a repair ' +
          'is refused, and so is a Purchase task.',
      }),
      Allow(),
    ),
  reason: () =>
    applyDecorators(
      ApiPropertyOptional({
        maxLength: REASON_MAX_LENGTH,
        description: 'What was done, for the history; optional.',
        example: 'Replaced cable',
      }),
      OptionalText('reason', REASON_MAX_LENGTH),
    ),
};

/** Body of `POST /staff/maintenance`: `maintenance.save` logging a repair. */
export class CreateRepairRequest {
  @RepairFields.assetId()
  assetId!: unknown;

  @RepairFields.vendorId()
  vendorId!: unknown;

  @RepairFields.description()
  description!: unknown;

  @RepairFields.costKobo()
  costKobo!: unknown;

  @RepairFields.status()
  status!: unknown;

  @RepairFields.taskId()
  taskId?: unknown;

  @RepairFields.reason()
  reason?: string;
}

/** Body of `PATCH /staff/maintenance/:id`: `maintenance.save` on a repair. */
export class UpdateRepairRequest extends VersionedWriteDto {
  @RepairFields.assetId()
  assetId!: unknown;

  @RepairFields.vendorId()
  vendorId!: unknown;

  @RepairFields.description()
  description!: unknown;

  @RepairFields.costKobo()
  costKobo!: unknown;

  @RepairFields.status()
  status!: unknown;

  @RepairFields.taskId()
  taskId?: unknown;

  @RepairFields.reason()
  reason?: string;
}

/** `GET /staff/maintenance`. */
export class RepairsQuery extends PaginationQuery {
  @ApiPropertyOptional({
    enum: MaintenanceStatus,
    enumName: 'MaintenanceStatus',
  })
  @ValidateIf(isSent)
  @IsEnum(MaintenanceStatus, { message: REPAIR_STATUS_FILTER_MESSAGE })
  status?: MaintenanceStatus;

  @ApiPropertyOptional({
    description:
      'Part of a repair number, the description, or the asset’s tag or ' +
      'name, any case.',
  })
  @Search()
  q?: string;
}
