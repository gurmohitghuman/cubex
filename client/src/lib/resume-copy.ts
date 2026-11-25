// What a Resume all that some runs refused says (hooks/sheet/useRunControls.ts), pure: each one's column and the
// server's reason, as "Score: The model is no longer available.", after how many resumed.
export function resumeFailedText(reasons: string[], tried: number): string {
  const head = reasons.length === tried
    ? `Couldn't resume ${tried === 1 ? 'the run' : `the ${tried} runs`}.`
    : `Resumed ${tried - reasons.length} of ${tried} runs. ${reasons.length === 1 ? 'One' : reasons.length} couldn't:`
  return `${head} ${reasons.join(' ')}`
}
