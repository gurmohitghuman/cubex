import { COLUMN_REF_PATTERN, normalizeColumnName } from './prompt';
import { TEMPLATE_TOKEN_RE } from './http-request-template';

// Column rename: rewrite the references a stored AI prompt or HTTP request
// template makes to the renamed column, so a later re-run reads the new name
// instead of failing on (or overwriting good results with) a missing one.
//
// A token counts as a reference to the column exactly when the run-time
// resolver would resolve it to that column: same token pattern, same matching
// rule (each resolver's own, copied below). Column names can't collide on
// those rules, so no other column's token is touched, and text the resolvers
// skip (URL path segments, "24/7") isn't either.

// processPromptTemplate / findUnknownColumnReferences (lib/prompt.ts).
const promptTokenIs = (token: string, column: string) =>
  normalizeColumnName(column) === token || column.toLowerCase() === token.toLowerCase();

// replaceTemplateVariables (lib/http-request-template.ts).
const templateTokenIs = (token: string, column: string) =>
  column.toLowerCase() === token.toLowerCase() ||
  normalizeColumnName(column) === normalizeColumnName(token);

// AI prompts: /token references.
export function renamePromptColumnRefs(prompt: string, oldName: string, newName: string): string {
  return prompt.replace(COLUMN_REF_PATTERN, (full, token: string) =>
    promptTokenIs(token, oldName) ? `/${normalizeColumnName(newName)}` : full);
}

// HTTP request templates (URL, headers, body): {{name}} and /token references.
export function renameTemplateColumnRefs(template: string, oldName: string, newName: string): string {
  return template.replace(TEMPLATE_TOKEN_RE, (full, braceInner: string | undefined, slashName: string | undefined) => {
    const token = braceInner !== undefined ? braceInner.trim() : slashName;
    if (!token || !templateTokenIs(token, oldName)) return full;
    // A "}" would end a {{...}} token early; the normalized name resolves too.
    if (braceInner !== undefined) return `{{${newName.includes('}') ? normalizeColumnName(newName) : newName}}}`;
    return `/${normalizeColumnName(newName)}`;
  });
}
