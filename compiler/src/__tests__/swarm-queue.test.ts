import { describe, expect, it } from 'vitest';
import { comparePriority, orderByPriority } from '../ir/swarm-queue.js';

describe('swarm priority queue', () => {
  it('runs P0 before P1 and P2 before P10', () => {
    const ordered = orderByPriority([
      { id: 'late', priority: 'P10' },
      { id: 'hot', priority: 'P0' },
      { id: 'next', priority: 'P1' },
      { id: 'mid', priority: 'P2' },
    ]);
    expect(ordered.map(item => item.id)).toEqual(['hot', 'next', 'mid', 'late']);
    expect(comparePriority('P0', 'P1')).toBeLessThan(0);
    expect(comparePriority('P2', 'P10')).toBeLessThan(0);
  });

  it('puts an unnumbered label after every numbered label, in locale order', () => {
    const ordered = orderByPriority([
      { id: 'beta', priority: 'beta' },
      { id: 'hot', priority: 'P0' },
      { id: 'alpha', priority: 'alpha' },
    ]);
    expect(ordered.map(item => item.id)).toEqual(['hot', 'alpha', 'beta']);
  });

  it('puts a missing priority last and keeps arrival order for one rank', () => {
    const ordered = orderByPriority([
      { id: 'earlier', priority: 'P0' },
      { id: 'none' },
      { id: 'later', priority: 'P0' },
    ]);
    expect(ordered.map(item => item.id)).toEqual(['earlier', 'later', 'none']);
  });

  it('uses the smaller number across different prefixes', () => {
    const ordered = orderByPriority([
      { id: 'a1', priority: 'A1' },
      { id: 'b0', priority: 'B0' },
    ]);
    expect(ordered.map(item => item.id)).toEqual(['b0', 'a1']);
  });
});
