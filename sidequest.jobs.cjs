// Sidequest manual-loader shim.
//
// Sidequest worker threads spawn fresh Node processes that don't inherit the
// tsx TypeScript transpilation hook the API process uses. So we can't point
// the worker at server/src/*.ts. Instead we point it at this `.cjs` file
// (Node treats .cjs as CommonJS regardless of the parent package.json
// "type":"module" setting at the repo root) which then re-exports the
// COMPILED job classes from server/dist/jobs/.
//
// `Sidequest.build(JobClass).enqueue(...)` records the class name on the job
// row. The runner then does `await import('sidequest.jobs.cjs')` and looks up
// `script[jobName] ?? script.default`. Our named exports below match the
// class names exactly.
//
// Dev loop: keep `tsc -p server/tsconfig.json --watch` running alongside the
// API process so dist/ stays fresh.
const path = require('node:path');
const COMPILED_JOBS_DIR = path.resolve(__dirname, 'server/dist/jobs');

const { AIRunJob } = require(path.join(COMPILED_JOBS_DIR, 'ai-run-job'));
const { AIRerunJob } = require(path.join(COMPILED_JOBS_DIR, 'ai-rerun-job'));
const { HTTPRunJob } = require(path.join(COMPILED_JOBS_DIR, 'http-run-job'));
const { HTTPRerunJob } = require(path.join(COMPILED_JOBS_DIR, 'http-rerun-job'));

module.exports = { AIRunJob, AIRerunJob, HTTPRunJob, HTTPRerunJob };
