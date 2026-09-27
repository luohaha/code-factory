/** A best-effort classification of the RD Agent's latest reply. */
export type JevWakeDecision = { kind: 'wait' | 'immediate' } | { kind: 'delayed'; minutes: number };

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 10_000;
const DELAY_LEVELS = [1, 2, 5, 10, 30, 60] as const;

export async function decideJevWake(apiKey: string, latestReply: string): Promise<JevWakeDecision> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: 'jev-latest',
      state: { latest_reply: latestReply },
      questions: {
        wake_action: {
          type: 'choice',
          instructions: 'Based on `latest_reply`, should the coding agent receive another turn? Choose wait if it has finished its work, needs a human decision, or is waiting for an external event or its own scheduled timer. Choose immediate only if it clearly needs another turn right now. Choose delayed only if it clearly needs another turn after a short pause.',
          criteria: {
            wait: 'Leave the agent waiting for a human message or its own external trigger.',
            immediate: 'Send continue. to the agent now to finish work it can do immediately.',
            delayed: 'Send continue. after a short delay to allow independently continuing work to progress.',
          },
        },
        delay: {
          type: 'score',
          instructions: 'If `latest_reply` calls for a delayed continuation, how many minutes should elapse? Choose the shortest suitable delay. Otherwise this answer will be ignored.',
          criteria: DELAY_LEVELS.map((minutes) => `${minutes} minute${minutes === 1 ? '' : 's'}`),
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('answers' in body)) throw new Error('Invalid Jev response');
  const answers = body.answers;
  if (!answers || typeof answers !== 'object' || !('wake_action' in answers)) throw new Error('Invalid Jev answer');
  const action = answers.wake_action;
  if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'choice'
    || !('choice' in action) || typeof action.choice !== 'string') throw new Error('Invalid Jev choice');
  if (action.choice === 'wait') return { kind: 'wait' };
  if (action.choice === 'immediate') return { kind: 'immediate' };
  if (action.choice !== 'delayed' || !('delay' in answers)) throw new Error('Invalid Jev choice');
  const delay = answers.delay;
  if (!delay || typeof delay !== 'object' || !('type' in delay) || delay.type !== 'score'
    || !('score' in delay) || typeof delay.score !== 'number' || !Number.isFinite(delay.score)
    || delay.score < 0 || delay.score > DELAY_LEVELS.length - 1) throw new Error('Invalid Jev delay');
  const lower = Math.floor(delay.score);
  const upper = Math.ceil(delay.score);
  const minutes = Math.round(DELAY_LEVELS[lower]! +
    (DELAY_LEVELS[upper]! - DELAY_LEVELS[lower]!) * (delay.score - lower));
  return { kind: 'delayed', minutes };
}
