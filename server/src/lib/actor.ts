// Who is making a change, for the trash (what deleted a batch) and the sheet
// change log: the app (a signed-in browser), an access token by name over
// /api/v1 or /mcp, or Cubex itself (auto-run, a restart finishing a job).
// Set once per request by the auth middleware (or the MCP route) and carried
// through every await by AsyncLocalStorage, so services don't pass it along.
// Anything outside a request reads as Cubex. tokenId: the token whose spend
// cap what is started here counts against (services/token-spend.ts); a sweep
// starting a setup's step runs as Cubex with the token that applied the setup.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';

export type Via = 'app' | 'api' | 'mcp' | 'cubex';
export interface Actor { via: Via; tokenName: string | null; tokenId: string | null }

const store = new AsyncLocalStorage<Actor>();
export const CUBEX: Actor = { via: 'cubex', tokenName: null, tokenId: null };
export const APP: Actor = { via: 'app', tokenName: null, tokenId: null };

// The token what is started now is done for (null: the app, or Cubex on its own).
export const actorTokenId = (): string | null => currentActor().tokenId;

export const currentActor = (): Actor => store.getStore() ?? CUBEX;

export function runAs<T>(actor: Actor, fn: () => T): T {
  return store.run(actor, fn);
}

// Express middleware: the rest of the request runs as `pick(req)`. The actor
// is kept on the request too, for a handler whose body arrives through stream
// events that lose the context (actAgain).
type ActorRequest = Request & { actor?: Actor };
export const actAs = (pick: (req: Request) => Actor) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const actor = pick(req);
    (req as ActorRequest).actor = actor;
    store.run(actor, next);
  };

// After a multipart parser: the request's actor again.
export const actAgain = (req: Request, _res: Response, next: NextFunction): void => {
  const actor = (req as ActorRequest).actor;
  if (actor) store.run(actor, next); else next();
};

// How the trash and the change log say who did it: "the app", "the token "Agent" (MCP)".
export function actorLabel(via: Via, tokenName: string | null): string {
  if (via === 'app') return 'the app';
  if (via === 'cubex') return 'Cubex';
  const surface = via === 'mcp' ? 'MCP' : 'the API';
  return tokenName ? `the token "${tokenName}" (${surface})` : surface;
}
