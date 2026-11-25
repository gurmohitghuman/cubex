// What Resume all says when runs refuse to resume (client/src/lib/resume-copy.ts, pure): each column and the
// server's reason, after how many resumed.
import assert from 'node:assert/strict'
import { resumeFailedText } from '../../client/src/lib/resume-copy'

assert.equal(resumeFailedText(['Score: The model is gone.'], 1), "Couldn't resume the run. Score: The model is gone.")
assert.equal(resumeFailedText(['A: x.', 'B: y.'], 2), "Couldn't resume the 2 runs. A: x. B: y.")
assert.equal(resumeFailedText(['B: y.'], 3), "Resumed 2 of 3 runs. One couldn't: B: y.")
assert.equal(resumeFailedText(['B: y.', 'C: z.'], 5), "Resumed 3 of 5 runs. 2 couldn't: B: y. C: z.")
console.log('ok   each refused run\'s column and reason, after how many resumed')
