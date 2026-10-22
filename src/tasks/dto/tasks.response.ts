import { ApiProperty } from '@nestjs/swagger';
import { TaskStatus, TaskType } from '../../../generated/cnc-client';

/** One step in a task's history: the History modal's rows. */
export class TaskHistoryResponse {
  @ApiProperty({ enum: TaskStatus, enumName: 'TaskStatus' })
  status!: TaskStatus;
  @ApiProperty({ description: 'When (ISO 8601, UTC).' }) at!: string;
  @ApiProperty({ type: String, nullable: true }) staffId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Who saved it; null if the account was removed.',
  })
  staffName!: string | null;
  @ApiProperty({
    description:
      'True when a command moved the task by itself (the staff app’s ' +
      '"<name> (automatic)").',
  })
  automatic!: boolean;
}

/** A task as the task routes answer it. */
export class TaskResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'T-000001' }) number!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: TaskType, enumName: 'TaskType' }) type!: TaskType;
  @ApiProperty({ enum: TaskStatus, enumName: 'TaskStatus' })
  status!: TaskStatus;
  @ApiProperty() assignedToId!: string;
  @ApiProperty() assignedToName!: string;
  @ApiProperty() raisedById!: string;
  @ApiProperty() raisedByName!: string;
  @ApiProperty({
    description:
      'Raised by a command (a purchase’s review or receive task, a ' +
      'repair’s follow-up) rather than by a person.',
  })
  automatic!: boolean;
  @ApiProperty({ type: String, nullable: true }) purchaseId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'PR-000001' })
  purchaseNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) maintenanceId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'MT-000001' })
  maintenanceNumber!: string | null;
  @ApiProperty({ description: 'When it was raised (ISO 8601, UTC).' })
  createdAt!: string;
  @ApiProperty({ type: TaskHistoryResponse, isArray: true })
  history!: TaskHistoryResponse[];
  @ApiProperty({ example: 0 }) version!: number;
}

/** How many of the reader's tasks are in each status. */
export class TaskCountsResponse {
  @ApiProperty() open!: number;
  @ApiProperty() inProgress!: number;
  @ApiProperty() done!: number;
}

export class TaskPageResponse {
  @ApiProperty({ type: TaskResponse, isArray: true }) data!: TaskResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    type: TaskCountsResponse,
    description:
      'The tasks the reader sees, by status, whatever the status and ' +
      'search filters.',
  })
  counts!: TaskCountsResponse;
}
