import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { StaffRole } from '../../generated/cnc-client';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PushQueueService, type PushTopics } from '../push/push-queue.service';
import {
  CreateTaskRequest,
  TasksQuery,
  UpdateTaskRequest,
} from './dto/tasks.request';
import { TaskPageResponse, TaskResponse } from './dto/tasks.response';
import { TasksService } from './tasks.service';

/**
 * The roles that open Tasks besides managers (plan §6.1), and so may save
 * one (§6.2, D42's role gate): a Waiter or Bartender may not.
 */
const TASK_ROLES = [
  StaffRole.RECEPTION,
  StaffRole.CASHIER,
  StaffRole.KITCHEN,
  StaffRole.STOREKEEPER,
] as const;

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const SAVE_BAD_REQUEST =
  '"Enter a task description.", "Select a task type.", "Invalid task ' +
  'status.", "Choose an open maintenance record.", "Choose an open purchase ' +
  'requisition.", or "Choose an active staff member. Waiters and ' +
  'bartenders report to their supervisors and are not assigned tasks."';

/**
 * Tasks (plan §5.4; card C5-5): follow-up work raised by people and by
 * commands, each person seeing their own.
 */
@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly idempotency: IdempotencyService,
    private readonly push: PushQueueService,
  ) {}

  @Get()
  @Roles(...TASK_ROLES)
  @ApiOperation({
    operationId: 'staffTasks',
    summary: 'Tasks: Open, then In Progress, then Done, newest first',
    description:
      'Managers read every task; anyone else the tasks assigned to them and ' +
      'those they raised. `counts` holds the reader’s tasks by status.',
  })
  @ApiResponse({ status: 200, type: TaskPageResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose a task status.", or a bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"Your current staff role cannot perform this action."',
    type: ApiErrorResponse,
  })
  list(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: TasksQuery,
  ): Promise<TaskPageResponse> {
    return this.tasks.list(actor, query);
  }

  @Post()
  @Roles(...TASK_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffTaskCreate',
    summary: 'Raise or assign a task (task.save)',
    description:
      'A manager assigns a task to anyone but a Waiter or Bartender; anyone ' +
      'else raises one to a manager or to themselves. Takes an ' +
      'Idempotency-Key, so a retry after a lost response does not raise it ' +
      'twice.',
  })
  @ApiResponse({ status: 201, type: TaskResponse })
  @ApiResponse({
    status: 400,
    description: `${SAVE_BAD_REQUEST}, or a missing Idempotency-Key.`,
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", or "Raise a ' +
      'task to a manager, or to yourself."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: 'The Idempotency-Key was used for a different request.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateTaskRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TaskResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const pushes: PushTopics = [];
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.tasks.create(tx, actor, request, ipAddress, pushes),
    });

    // After the commit (C10); a replay ran no work and pushes nothing.
    await this.push.dispatchTopics(pushes);
    response.status(result.status);

    return result.body;
  }

  @Patch(':id')
  @Roles(...TASK_ROLES)
  @ApiParam({ name: 'id', description: 'Task.id.' })
  @ApiOperation({
    operationId: 'staffTaskUpdate',
    summary: 'Save a task (task.save)',
    description:
      'The assignee moves their task’s status; a manager edits, reassigns ' +
      'and links any task. Every save adds a history step.',
  })
  @ApiResponse({ status: 200, type: TaskResponse })
  @ApiResponse({
    status: 400,
    description: `${SAVE_BAD_REQUEST}, or a bad version.`,
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", "Only the ' +
      'assigned staff member or a manager can update this task.", "Only a ' +
      'manager can change task details.", "Only a manager can reassign ' +
      'tasks.", or "Only a manager can change task links or type."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description: '"Task not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: '"This record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  update(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateTaskRequest,
    @Req() httpRequest: Request,
  ): Promise<TaskResponse> {
    return this.tasks.update(actor, id, request, clientAddressOf(httpRequest));
  }
}
