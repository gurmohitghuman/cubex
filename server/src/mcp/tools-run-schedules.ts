import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import {
  changeSchedule, createSchedule, deleteSchedule, listSchedules, pauseSchedule,
} from '../services/run-schedule-store';
import { fireScheduleNow } from '../services/run-schedule-fire';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

// Scheduled reruns (services/run-schedule*.ts): manage_run_schedule.
export function registerRunScheduleTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'manage_run_schedule', {
    description:
      'Rerun a sheet\'s run columns (or a table\'s, sheet by sheet) on a schedule. Each firing is a column run '
      + '(as run_columns, as this token: COSTS MONEY each time) on the rows picked; max_cost_usd refuses a firing '
      + 'that could cost more (a table\'s sheets share it). change and resume make the schedule this token\'s; '
      + 'fire_now runs as this token. A firing missed while Cubex was stopped runs once. last_error says why one '
      + 'didn\'t start. list needs read; the rest run.',
    inputSchema: z.object({
      action: z.enum(['list', 'create', 'change', 'pause', 'resume', 'delete', 'fire_now']).describe('What to do'),
      schedule_id: z.string().optional().describe('The schedule (not for list or create)'),
      sheet_id: z.string().optional().describe('create: the sheet; list: its schedules'),
      table_id: z.string().optional().describe('create: every sheet of this table instead'),
      columns: z.array(z.string()).nullable().optional().describe('Run columns; omit or null for all'),
      rows: z.enum(['empty', 'errored', 'out_of_date', 'all']).optional().describe('Which rows each firing runs'),
      cadence: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'hours']).optional().describe('How often'),
      at_time: z.string().optional().describe('HH:MM, 24-hour (not for hours)'),
      time_zone: z.string().optional().describe('IANA zone, default UTC'),
      weekday: z.number().int().min(0).max(6).optional().describe('weekly: 0 Sunday to 6 Saturday'),
      month_day: z.number().int().min(1).max(28).optional().describe('monthly: 1-28'),
      every_hours: z.number().int().min(1).max(168).optional().describe('hours: 1-168'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).nullable().optional()
        .describe('Per firing, in dollars'),
      allow_unpriced: lenientBoolean().optional().describe('With max_cost_usd: run columns with no known price'),
    }).strict(),
  }, async ({ action, schedule_id, ...f }) => {
    const denied = missingScope(ctx, action === 'list' ? 'read' : 'run');
    if (denied) return denied;
    if (action === 'list') {
      return ok({ schedules: listSchedules(ctx.userId, { sheetId: f.sheet_id, tableId: f.table_id }) });
    }
    if (action === 'create') {
      const out = createSchedule(ctx.userId, f, { hasSecretsScope: ctx.scopes.has('secrets') });
      return 'fail' in out ? err(out.message) : ok({ schedule: out.ok });
    }
    if (!schedule_id) return err('Pass schedule_id (manage_run_schedule list shows them).');
    const caller = { hasSecretsScope: ctx.scopes.has('secrets') };
    const out = action === 'change' ? changeSchedule(ctx.userId, schedule_id, f, caller)
      : action === 'pause' || action === 'resume'
        ? pauseSchedule(ctx.userId, schedule_id, action === 'pause', caller)
      : action === 'fire_now' ? await fireScheduleNow(ctx.userId, schedule_id, caller)
      : deleteSchedule(ctx.userId, schedule_id);
    if ('fail' in out) return err(out.message);
    return ok('deleted' in out.ok ? out.ok : { schedule: out.ok });
  });
}
