// Imported first by a unit test that wants the e2e runs' strict output check (scripts/e2e-env.mjs): an answer
// with a field its tool's outputSchema doesn't name fails the call. mcp/output-schema.ts reads it when loaded.
process.env.CUBEX_TEST_STRICT_OUTPUT = '1'
