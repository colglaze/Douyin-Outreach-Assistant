export type FeedAutoMode = 'LIMITED' | 'CONTINUOUS';

export function effectiveSendLimit(mode: FeedAutoMode, configuredLimit: number): number | null {
  return mode === 'CONTINUOUS' ? null : configuredLimit || 10;
}

export function reachedSendLimit(mode: FeedAutoMode, sent: number, configuredLimit: number): boolean {
  const limit = effectiveSendLimit(mode, configuredLimit);
  return limit !== null && sent >= limit;
}

export function reachedDatingProfileLimit(mode: FeedAutoMode, visitedCount: number, limit: number): boolean {
  return mode === 'LIMITED' && visitedCount >= limit;
}

export function shouldContinueSearching(mode: FeedAutoMode, emptyRounds: number, limitedMaxRounds: number): boolean {
  return mode === 'CONTINUOUS' || emptyRounds < limitedMaxRounds;
}
