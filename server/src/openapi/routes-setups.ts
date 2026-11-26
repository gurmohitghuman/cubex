// /api/v1 routes: setups (a saved chain of filled columns) and setup versions
// (a sheet's column setup kept by name) (api-v1-setups.ts, api-v1-setup-versions.ts).
import { z } from 'zod';
import {
  MAX_SETUP_DESCRIPTION_CHARS, MAX_SETUP_NAME_CHARS, SETUP_FILE_FORMAT, SETUP_FILE_VERSION,
} from '../lib/constants-setups';
import { op, type RouteDoc } from './route-doc';
import { toolBody } from './tool-schemas';

const setupName = z.string().max(MAX_SETUP_NAME_CHARS);
const setupDescription = z.string().max(MAX_SETUP_DESCRIPTION_CHARS).nullable();
const columns = z.array(z.string()).min(1).describe('The filled columns to save, such as ["Fit (Output)"].');
const upstream = z.boolean().optional().describe('Also save the filled columns they read. Default true.');
const named = z.object({ name: setupName.optional(), description: setupDescription.optional() });

export const setupRoutes = (): RouteDoc[] => [
  op({
    method: 'get', path: '/setups', operationId: 'listSetups', tag: 'setups', scope: 'read',
    summary: 'List the saved setups.',
  }),
  op({
    method: 'post', path: '/setups/import', operationId: 'importSetup', tag: 'setups', scope: 'write',
    summary: 'Import a setup file exported from a Cubex. A name already taken gets " (2)".',
    body: z.object({
      format: z.literal(SETUP_FILE_FORMAT), version: z.literal(SETUP_FILE_VERSION),
      name: setupName, description: setupDescription.optional(),
      spec: z.record(z.string(), z.unknown()).describe('The steps, as the export wrote them.'),
    }).describe('The file object from GET /setups/{setupId}/export, sent as it is.'),
    responses: { 201: 'The imported setup.' },
  }),
  op({
    method: 'get', path: '/setups/{setupId}', operationId: 'getSetup', tag: 'setups', scope: 'read',
    summary: 'One setup in full.',
  }),
  op({
    method: 'get', path: '/setups/{setupId}/export', operationId: 'exportSetup', tag: 'setups', scope: 'read',
    summary: 'A setup as a file for another Cubex, saved keys by name only.',
    description: 'Refused while a key is typed straight into a request.',
  }),
  op({
    method: 'patch', path: '/setups/{setupId}', operationId: 'updateSetup', tag: 'setups', scope: 'write',
    summary: 'Rename or describe a setup.', body: named,
  }),
  op({
    method: 'delete', path: '/setups/{setupId}', operationId: 'deleteSetup', tag: 'setups', scope: 'write',
    summary: 'Delete a setup for good.', conflict: false,
  }),
  op({
    method: 'get', path: '/sheets/{id}/setup-steps', operationId: 'getSetupSteps', tag: 'setups', scope: 'read',
    summary: "A sheet's filled columns as setup steps: what each reads, or why it can't be saved.",
  }),
  op({
    method: 'post', path: '/sheets/{id}/setups/plan', operationId: 'planSetup', tag: 'setups', scope: 'read',
    summary: 'What a setup of these columns would hold. Saves nothing.',
    body: z.object({ columns, include_upstream: upstream }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/setups', operationId: 'saveSetup', tag: 'setups', scope: 'write',
    summary: "Save a sheet's filled columns as a named setup, to build them again on other sheets.",
    body: z.object({ name: setupName, description: setupDescription.optional(), columns, include_upstream: upstream }),
    responses: { 201: 'The saved setup.' },
  }),
  op({
    method: 'post', path: '/sheets/{id}/setups/{setupId}/apply', operationId: 'applySetup', tag: 'setups',
    scope: 'run', summary: "Build a setup's columns on a sheet and run them, or price that first.",
    description: "Same as MCP's apply_setup, but estimate_only defaults to false here. Saved keys need secrets. "
      + 'A missing input or a name taken answers missing or taken.',
    body: toolBody('apply_setup', {
      omit: ['sheet_id', 'setup_id', 'estimate_only'],
      extend: { estimate_only: z.boolean().optional().describe('true prices it and starts nothing. Default false.') },
    }),
    responses: { 200: 'The estimate.', 201: 'Started: the setup_run.' },
  }),
  op({
    method: 'post', path: '/setups/{setupId}/calls', operationId: 'callSetup', tag: 'setups', scope: 'run',
    summary: 'Run a saved setup on 1-100 items without a sheet, or price that first.',
    description: "Same as MCP's call_setup, but estimate_only defaults to false here. Each item is an object keyed by "
      + "the setup's input names. Poll GET /setup-calls/{callId} for each item's outputs; "
      + 'POST /setup-runs/{runId}/control with the call id pauses, resumes or cancels it.',
    body: toolBody('call_setup', {
      omit: ['setup_id', 'estimate_only'],
      extend: { estimate_only: z.boolean().optional().describe('true prices it and starts nothing. Default false.') },
    }),
    responses: { 200: 'The estimate.', 201: 'Started: the setup_call.' },
  }),
  op({
    method: 'get', path: '/setup-calls/{callId}', operationId: 'getSetupCall', tag: 'setups', scope: 'read',
    summary: "A setup call: its status, and once it has finished each item's outputs.",
  }),
  op({
    method: 'post', path: '/sheets/{id}/column-runs', operationId: 'runColumns', tag: 'setups', scope: 'run',
    summary: "Run several of a sheet's run columns again on chosen rows, or price that first.",
    description: "Same as MCP's run_columns, but estimate_only defaults to false here. Followed as a setup run "
      + '(GET /setup-runs/{runId}). Saved keys need secrets.',
    body: toolBody('run_columns', {
      omit: ['sheet_id', 'estimate_only'],
      extend: { estimate_only: z.boolean().optional().describe('true prices it and starts nothing. Default false.') },
    }),
    responses: { 200: 'The estimate.', 201: 'Started: the setup_run.' },
  }),
  op({
    method: 'get', path: '/run-schedules', operationId: 'listRunSchedules', tag: 'setups', scope: 'read',
    summary: "Scheduled reruns: yours, a sheet's (with its table's) or a table's, soonest first.",
    query: z.object({
      sheet_id: z.string().optional().describe("A sheet's schedules, and its table's."),
      table_id: z.string().optional().describe("A table's schedules, and its sheets'."),
    }),
  }),
  op({
    method: 'get', path: '/run-schedules/{id}', operationId: 'getRunSchedule', tag: 'setups', scope: 'read',
    summary: 'One schedule: its settings, next firing and last firing.',
  }),
  op({
    method: 'post', path: '/run-schedules', operationId: 'createRunSchedule', tag: 'setups', scope: 'run',
    summary: "Rerun a sheet's (or a table's) run columns on a schedule.",
    description: 'Each firing is a column run as this token. A firing missed while Cubex was stopped runs once.',
    body: toolBody('manage_run_schedule', { omit: ['action', 'schedule_id'] }),
    responses: { 201: 'The schedule.' },
  }),
  op({
    method: 'patch', path: '/run-schedules/{id}', operationId: 'changeRunSchedule', tag: 'setups', scope: 'run',
    summary: 'Change a schedule, or pause or resume it (paused).',
    body: toolBody('manage_run_schedule', { omit: ['action', 'schedule_id', 'sheet_id', 'table_id'],
      extend: { paused: z.boolean().optional().describe('true pauses it; false resumes it from now.') } }),
  }),
  op({
    method: 'delete', path: '/run-schedules/{id}', operationId: 'deleteRunSchedule', tag: 'setups', scope: 'run',
    summary: 'Delete a schedule. Runs it started stay.',
  }),
  op({
    method: 'get', path: '/run-schedules/{id}/estimate', operationId: 'estimateRunSchedule', tag: 'setups',
    scope: 'run', summary: 'What firing a schedule now would cost, sheet by sheet; nothing starts.',
  }),
  op({
    method: 'post', path: '/run-schedules/{id}/fire', operationId: 'fireRunSchedule', tag: 'setups', scope: 'run',
    summary: 'Fire a schedule once now; its next time stays as it was.',
  }),
  op({
    method: 'get', path: '/sheets/{id}/setup-runs', operationId: 'listSetupRuns', tag: 'setups', scope: 'read',
    summary: 'The setups being used on a sheet, newest first.',
    query: z.object({ setup_id: z.string().optional().describe("Only this setup's runs.") }),
  }),
  op({
    method: 'get', path: '/setup-runs/{runId}', operationId: 'getSetupRun', tag: 'setups', scope: 'read',
    summary: 'One setup run, with the choices it was used with.',
  }),
  op({
    method: 'post', path: '/setup-runs/{runId}/control', operationId: 'controlSetupRun', tag: 'setups',
    scope: 'run', summary: 'Pause, resume or cancel a setup being used on a sheet.',
    body: toolBody('control_setup_run', { pick: ['action'] }),
  }),
  op({
    method: 'get', path: '/sheets/{id}/setup-versions', operationId: 'listSetupVersions', tag: 'versions',
    scope: 'read', summary: "A sheet's setup versions, newest first.",
  }),
  op({
    method: 'post', path: '/sheets/{id}/setup-versions', operationId: 'saveSetupVersion', tag: 'versions',
    scope: 'write', summary: "Keep the sheet's column setup as it is now, by name.",
    body: z.object({ name: setupName, description: setupDescription.optional() }),
    responses: { 201: 'The saved version.' },
  }),
  op({
    method: 'get', path: '/sheets/{id}/setup-versions/{versionId}', operationId: 'getSetupVersion',
    tag: 'versions', scope: 'read', summary: 'A setup version compared with the sheet now: what restoring would do.',
  }),
  op({
    method: 'patch', path: '/sheets/{id}/setup-versions/{versionId}', operationId: 'updateSetupVersion',
    tag: 'versions', scope: 'write', summary: 'Rename or describe a setup version.', body: named,
  }),
  op({
    method: 'delete', path: '/sheets/{id}/setup-versions/{versionId}', operationId: 'deleteSetupVersion',
    tag: 'versions', scope: 'write', summary: "Delete a setup version for good. The sheet doesn't change.",
  }),
  op({
    method: 'post', path: '/sheets/{id}/setup-versions/{versionId}/restore', operationId: 'restoreSetupVersion',
    tag: 'versions', scope: 'read', scopeNote: 'Restoring (dry_run false) needs write and run, and secrets when '
      + 'a request it puts back reads a saved key.',
    summary: 'Say what restoring a setup version would do, or restore it when dry_run is false.',
    body: toolBody('restore_setup_version', { pick: ['dry_run'] }),
  }),
  // Tests of column changes on sample rows (api-v1-sheet-test.ts): {id} is the sheet's or its test copy's.
  op({
    method: 'get', path: '/sheets/{id}/test', operationId: 'getSheetTest', tag: 'versions', scope: 'read',
    summary: "The sheet's open test of column changes, or null.",
  }),
  op({
    method: 'post', path: '/sheets/{id}/test', operationId: 'startSheetTest', tag: 'versions', scope: 'write',
    summary: "Copy the sheet's top rows (or row_ids) and setup into a hidden copy to try column changes on. The "
      + 'sheet takes no changes until the test is applied or discarded; its webhook deliveries wait.',
    body: toolBody('manage_sheet', { pick: ['row_ids', 'rows'] }), responses: { 201: 'The test.' },
  }),
  op({
    method: 'post', path: '/sheets/{id}/test/rows', operationId: 'addSheetTestRows', tag: 'versions',
    scope: 'write', summary: 'Copy more of the sheet\'s rows into its test: from the top, at random, or row_ids.',
    body: toolBody('manage_sheet', { pick: ['row_ids', 'rows', 'how'] }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/test/apply', operationId: 'applySheetTest', tag: 'versions',
    scope: 'read', scopeNote: 'Applying (dry_run false) needs write and run, and secrets when a request it writes '
      + 'reads a saved key.',
    summary: "Say what applying the test would do, or make the copy's setup the sheet's and put the sample rows' "
      + 'results back when dry_run is false. Ends the test.',
    body: toolBody('manage_sheet', { pick: ['dry_run'] }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/test/discard', operationId: 'discardSheetTest', tag: 'versions',
    scope: 'write', summary: 'Drop the test copy: the sheet stays as it was and takes changes again.',
  }),
];
