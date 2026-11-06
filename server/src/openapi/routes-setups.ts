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
];
