import { describe, expect, it } from 'vitest';
import { deleteSelectionFills, remapTableFills } from './table-fill';

describe('table fill structure changes', () => {
  const grid = [['A', 'B'], ['C', 'D']];
  it('moves fill with its row or column, including empty inserted axes', () => {
    expect(remapTableFills(grid, { kind: 'insertRow', at: 1 })).toEqual([['A','B'], ['',''], ['C','D']]);
    expect(remapTableFills(grid, { kind: 'insertCol', at: 0 })).toEqual([['','A','B'], ['','C','D']]);
    expect(remapTableFills(grid, { kind: 'moveRow', index: 0, to: 1 })).toEqual([['C','D'], ['A','B']]);
    expect(remapTableFills(grid, { kind: 'moveCol', index: 0, to: 1 })).toEqual([['B','A'], ['D','C']]);
    expect(remapTableFills(grid, { kind: 'clearRow', index: 0 })).toEqual(grid);
  });
  it('removes the selected full rows or columns without shifting the wrong fill', () => {
    const three = [['A','B','C'], ['D','E','F'], ['G','H','I']];
    expect(deleteSelectionFills(three, 'rows', { r0: 0, r1: 1, c0: 0, c1: 2 })).toEqual([['G','H','I']]);
    expect(deleteSelectionFills(three, 'cols', { r0: 0, r1: 2, c0: 1, c1: 2 })).toEqual([['A'], ['D'], ['G']]);
  });
});
