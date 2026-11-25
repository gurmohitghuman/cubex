-- A sheet webhook's optional token (services/sheet-webhook.ts, routes/webhooks-public.ts): with one set, an
-- event must send it as Authorization: Bearer <token>, or it gets the generic 404 before its body is read.
-- Only its sha256 is kept: the token is shown once, when it is made. NULL: no token, as for every webhook
-- made before this.
ALTER TABLE webhook_sources ADD COLUMN auth_token_hash TEXT;
ALTER TABLE webhook_sources ADD COLUMN auth_token_set_at TEXT;
