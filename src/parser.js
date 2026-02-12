/**
 * Parse gamified task messages from the OpenClaw agent.
 *
 * Expected format example:
 *   Day 42 | Streak: 5 | Hearts: 3 | XP: 1250 | Level: 7
 *
 *   Today's Quests:
 *   1. ✅ Review PR for auth module
 *   2. ⬜️ Complete API integration tests
 *   3. ⬜️ Update documentation for new endpoints
 *   4. ⬜️ Deploy staging environment
 */

const STATS_PATTERN = /Day\s+(\d+)\s*\|?\s*.*?Streak[:\s]+(\d+)\s*\|?\s*.*?Hearts?[:\s]+(\d+)\s*\|?\s*.*?XP[:\s]+([\d,]+)\s*\|?\s*.*?Level[:\s]+(\d+)/i;

const TASK_LINE_PATTERN = /^\s*(\d+)\.\s*(✅|⬜️?|☑️|🔲|▪️|\[x\]|\[\s?\])\s*(.+)$/;

export function parseTaskMessage(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const statsMatch = text.match(STATS_PATTERN);
  const lines = text.split('\n');

  const items = [];
  for (const line of lines) {
    const taskMatch = line.match(TASK_LINE_PATTERN);
    if (taskMatch) {
      const [, num, check, taskText] = taskMatch;
      const completed = check === '✅' || check === '☑️' || check === '[x]';
      items.push({
        id: parseInt(num, 10),
        text: taskText.trim(),
        completed,
      });
    }
  }

  if (!statsMatch && items.length === 0) {
    return null;
  }

  return {
    day: statsMatch ? parseInt(statsMatch[1], 10) : null,
    stats: statsMatch
      ? {
          streak: parseInt(statsMatch[2], 10),
          hearts: parseInt(statsMatch[3], 10),
          xp: parseInt(statsMatch[4].replace(/,/g, ''), 10),
          level: parseInt(statsMatch[5], 10),
        }
      : null,
    items,
  };
}

/**
 * Accumulate streamed text deltas into a complete message.
 */
export function createDeltaAccumulator() {
  let buffer = '';

  return {
    append(delta) {
      buffer += delta;
    },
    get text() {
      return buffer;
    },
    parse() {
      return parseTaskMessage(buffer);
    },
    reset() {
      buffer = '';
    },
  };
}
