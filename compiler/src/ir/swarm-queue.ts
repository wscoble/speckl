// Priority order for swarm work.
//
// A priority is the label an action or a domain already declares. It is not
// a queue until something dequeues it. A trailing integer is the rank, so
// P0 comes before P1 and P2 comes before P10. A label with no trailing
// integer comes after every numbered label, in locale order. A missing
// priority comes last. The same label keeps arrival order. The same
// number with two prefixes is ordered by the prefix.

export interface QueueItem {
  priority?: string;
}

interface Rank {
  band: number;
  number: number;
  label: string;
}

export function priorityRank(priority?: string): Rank {
  if (priority === undefined) return { band: 2, number: 0, label: '' };
  const match = priority.match(/^(.*?)(\d+)$/);
  if (!match) return { band: 1, number: 0, label: priority };
  return { band: 0, number: Number(match[2]), label: match[1] };
}

export function comparePriority(left?: string, right?: string): number {
  const a = priorityRank(left);
  const b = priorityRank(right);
  if (a.band !== b.band) return a.band - b.band;
  if (a.number !== b.number) return a.number - b.number;
  return a.label.localeCompare(b.label);
}

/** Arrival order, then priority. The input array is not mutated. */
export function orderByPriority<T extends QueueItem>(items: readonly T[]): T[] {
  return items
    .map((item, seq) => ({ item, seq }))
    .sort((left, right) => {
      const byPriority = comparePriority(left.item.priority, right.item.priority);
      return byPriority !== 0 ? byPriority : left.seq - right.seq;
    })
    .map(entry => entry.item);
}
