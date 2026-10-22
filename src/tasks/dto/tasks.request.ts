import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsEnum,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { TaskStatus, TaskType } from '../../../generated/cnc-client';
import { Checked, requiredText } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { trimText } from '../../common/trim-text';
import {
  TASK_STATUS_FILTER_MESSAGE,
  TASK_STATUS_MESSAGE,
  TASK_TITLE_MAX_LENGTH,
  TASK_TITLE_MESSAGE,
  TASK_TYPE_MESSAGE,
} from '../task-messages';

/**
 * `task.save`'s fields. Each answers one sentence at most (`Checked`, a
 * single class-validator decorator), so the demo's sentence reaches the
 * screen once (A7). The assignee and the links are admitted here
 * (`@Allow()`) and judged in the service: who may be named depends on who
 * is saving and on the stored task, and each answer is the demo's own
 * sentence.
 */

const Title = () =>
  applyDecorators(
    ApiProperty({
      description: 'What needs doing.',
      maxLength: TASK_TITLE_MAX_LENGTH,
      example: 'Placed an order with the vendor',
    }),
    Transform(({ value }) => trimText(value)),
    Checked(
      requiredText(
        TASK_TITLE_MESSAGE,
        TASK_TITLE_MAX_LENGTH,
        `title must be ${TASK_TITLE_MAX_LENGTH} characters or fewer.`,
      ),
    ),
  );

const Type = () =>
  applyDecorators(
    ApiProperty({
      enum: TaskType,
      enumName: 'TaskType',
      description:
        'A Purchase task links an open requisition, a Maintenance task an ' +
        'open repair; a General task links nothing.',
    }),
    IsEnum(TaskType, { message: TASK_TYPE_MESSAGE }),
  );

const Status = () =>
  applyDecorators(
    ApiProperty({ enum: TaskStatus, enumName: 'TaskStatus' }),
    IsEnum(TaskStatus, { message: TASK_STATUS_MESSAGE }),
  );

const AssignedTo = (description: string) =>
  applyDecorators(ApiPropertyOptional({ type: String, description }), Allow());

const PurchaseLink = () =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      description:
        'Purchase.id, for a Purchase task: a requisition that is not ' +
        'Fulfilled, Rejected or Cancelled (or the one the task already ' +
        'links). Ignored for any other type.',
    }),
    Allow(),
  );

const MaintenanceLink = () =>
  applyDecorators(
    ApiPropertyOptional({
      type: String,
      description:
        'MaintenanceRecord.id, for a Maintenance task: a repair that is ' +
        'not Fixed or Not Fixed (or the one the task already links). ' +
        'Ignored for any other type.',
    }),
    Allow(),
  );

/** Body of `POST /staff/tasks`: `task.save` raising a task. */
export class CreateTaskRequest {
  @Title()
  title!: string;

  @Type()
  type!: TaskType;

  @Status()
  status!: TaskStatus;

  @AssignedTo(
    'Staff.id. A manager assigns any active member of staff but a Waiter ' +
      'or Bartender; anyone else raises a task to a manager or to themselves.',
  )
  assignedToId?: unknown;

  @PurchaseLink()
  purchaseId?: unknown;

  @MaintenanceLink()
  maintenanceId?: unknown;
}

/**
 * Body of `PATCH /staff/tasks/:id`: `task.save` on a task that exists. The
 * staff app sends the whole task. Anyone but a manager may change only its
 * status, and only on a task assigned to them; a description, assignee,
 * type or link they send must be the task's own.
 */
export class UpdateTaskRequest extends VersionedWriteDto {
  @Title()
  title!: string;

  @Type()
  type!: TaskType;

  @Status()
  status!: TaskStatus;

  @AssignedTo(
    'Staff.id: required of a manager; anyone else may leave it out or send ' +
      'the task’s own.',
  )
  assignedToId?: unknown;

  @PurchaseLink()
  purchaseId?: unknown;

  @MaintenanceLink()
  maintenanceId?: unknown;
}

/** `GET /staff/tasks`. */
export class TasksQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: TaskStatus, enumName: 'TaskStatus' })
  @ValidateIf(isSent)
  @IsEnum(TaskStatus, { message: TASK_STATUS_FILTER_MESSAGE })
  status?: TaskStatus;

  @ApiPropertyOptional({
    description: 'Part of a task number or description, any case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}
