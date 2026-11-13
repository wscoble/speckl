import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runTick } from '../ir/swarm-tick.js';

describe('swarm tick', () => {
  it('admits cost 0 against a zero budget and waits on the next positive cost', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 0 }],
      [
        { domain: 'Left', id: 'free', cost: 0, priority: 'P0' },
        { domain: 'Left', id: 'paid', cost: 1, priority: 'P1' },
      ],
    );
    expect(tick.ran.map(item => item.id)).toEqual(['free']);
    expect(tick.waiting.map(item => item.id)).toEqual(['paid']);
  });

  it('stops at the first item that does not fit and does not run a cheaper item behind it', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 3 }],
      [
        { domain: 'Left', id: 'head', cost: 2, priority: 'P0' },
        { domain: 'Left', id: 'block', cost: 2, priority: 'P1' },
        { domain: 'Left', id: 'cheap', cost: 1, priority: 'P2' },
      ],
    );
    expect(tick.ran.map(item => item.id)).toEqual(['head']);
    expect(tick.waiting.map(item => item.id)).toEqual(['block', 'cheap']);
  });

  it('runs a later tick from a fresh budget and does not drop the waiting item', () => {
    const first = runTick(
      [{ name: 'Left', budgetPerTick: 3 }],
      [
        { domain: 'Left', id: 'a', cost: 2, priority: 'P0' },
        { domain: 'Left', id: 'b', cost: 2, priority: 'P1' },
      ],
    );
    const second = runTick([{ name: 'Left', budgetPerTick: 3 }], first.waiting);
    expect(first.ran.map(item => item.id)).toEqual(['a']);
    expect(second.ran.map(item => item.id)).toEqual(['b']);
    expect(second.waiting).toEqual([]);
  });

  it('admits every item when the domain declares no budget', () => {
    const tick = runTick(
      [{ name: 'Left' }],
      [
        { domain: 'Left', id: 'late', cost: 9, priority: 'P1' },
        { domain: 'Left', id: 'hot', cost: 9, priority: 'P0' },
      ],
    );
    expect(tick.ran.map(item => item.id)).toEqual(['hot', 'late']);
    expect(tick.waiting).toEqual([]);
  });

  it('does not run an item whose own cost is greater than the budget', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 3 }],
      [{ domain: 'Left', id: 'over', cost: 4, priority: 'P0' }],
    );
    expect(tick.ran).toEqual([]);
    expect(tick.waiting.map(item => item.id)).toEqual(['over']);
  });

  it('admits an item whose cost equals the budget', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 3 }],
      [{ domain: 'Left', id: 'exact', cost: 3, priority: 'P0' }],
    );
    expect(tick.ran.map(item => item.id)).toEqual(['exact']);
    expect(tick.waiting).toEqual([]);
  });

  it('compileSpec does not call the tick scheduler', () => {
    const src = readFileSync(new URL('../compile.ts', import.meta.url), 'utf8');
    expect(src.includes('runTick')).toBe(false);
    expect(src.includes('swarm-tick')).toBe(false);
  });

  it('schedules domains independently and waits on work for a domain that is not in the tick', () => {
    const tick = runTick(
      [
        { name: 'Left', budgetPerTick: 1 },
        { name: 'Right', budgetPerTick: 0 },
      ],
      [
        { domain: 'Left', id: 'left', cost: 1, priority: 'P0' },
        { domain: 'Right', id: 'right', cost: 1, priority: 'P0' },
        { domain: 'Other', id: 'other', cost: 0, priority: 'P0' },
      ],
    );
    expect(tick.ran.map(item => item.id)).toEqual(['left']);
    expect(tick.waiting.map(item => item.id)).toEqual(['right', 'other']);
  });

  it('a negative cost waits and blocks the cheaper item behind it', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 5 }],
      [
        { domain: 'Left', id: 'bad', cost: -1, priority: 'P0' },
        { domain: 'Left', id: 'cheap', cost: 1, priority: 'P1' },
      ],
    );
    expect(tick.ran).toEqual([]);
    expect(tick.waiting.map(item => item.id)).toEqual(['bad', 'cheap']);
  });

  it('an infinite cost waits and blocks the item behind it', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 5 }],
      [
        { domain: 'Left', id: 'inf', cost: Number.POSITIVE_INFINITY, priority: 'P0' },
        { domain: 'Left', id: 'behind', cost: 1, priority: 'P1' },
      ],
    );
    expect(tick.ran).toEqual([]);
    expect(tick.waiting.map(item => item.id)).toEqual(['inf', 'behind']);
  });

  it('a cost that is not a number waits', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 5 }],
      [{ domain: 'Left', id: 'nan', cost: Number.NaN, priority: 'P0' }],
    );
    expect(tick.ran).toEqual([]);
    expect(tick.waiting.map(item => item.id)).toEqual(['nan']);
  });

  it('waits every item when the tick names no domain', () => {
    const tick = runTick([], [
      { domain: 'Left', id: 'a', cost: 0, priority: 'P0' },
      { domain: 'Left', id: 'b', cost: 0, priority: 'P1' },
    ]);
    expect(tick.ran).toEqual([]);
    expect(tick.waiting.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('does not run the item after the one that fills the budget', () => {
    const tick = runTick(
      [{ name: 'Left', budgetPerTick: 3 }],
      [
        { domain: 'Left', id: 'fill', cost: 3, priority: 'P0' },
        { domain: 'Left', id: 'after', cost: 1, priority: 'P1' },
      ],
    );
    expect(tick.ran.map(item => item.id)).toEqual(['fill']);
    expect(tick.waiting.map(item => item.id)).toEqual(['after']);
  });

  it('does not mutate the caller work list', () => {
    const work = [
      { domain: 'Left', id: 'b', cost: 1, priority: 'P1' },
      { domain: 'Left', id: 'a', cost: 1, priority: 'P0' },
    ];
    const before = work.map(item => item.id);
    runTick([{ name: 'Left', budgetPerTick: 5 }], work);
    expect(work.map(item => item.id)).toEqual(before);
  });
});
