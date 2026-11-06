// Every /api/v1 route, by area, listed once on first use: the bodies read the
// MCP tools' schemas, which registers every tool on a stand-in server
// (tool-schemas.ts). tests/unit/openapi.test.ts checks it against the router.
import type { RouteDoc } from './route-doc';
import { tableRoutes } from './routes-tables';
import { rowRoutes } from './routes-rows';
import { fillRoutes } from './routes-fill';
import { runRoutes } from './routes-runs';
import { runControlRoutes } from './routes-run-control';
import { setupRoutes } from './routes-setups';
import { hookRoutes } from './routes-hooks';
import { trashRoutes } from './routes-trash';

let routes: RouteDoc[] | null = null;

export function apiV1Routes(): RouteDoc[] {
  routes ??= [
    ...tableRoutes(), ...rowRoutes(), ...fillRoutes(), ...runRoutes(), ...runControlRoutes(),
    ...setupRoutes(), ...hookRoutes(), ...trashRoutes(),
  ];
  return routes;
}
