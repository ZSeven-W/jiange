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
  it('moves formatting by the same permutation as nonadjacent rows and columns', () => {
    const values=[['a','b','c','d'],['e','f','g','h'],['i','j','k','l']];
    expect(remapTableFills(values,{kind:'reorderRows',indices:[0,2],before:1})).toEqual([values[0],values[2],values[1]]);
    expect(remapTableFills(values,{kind:'reorderCols',indices:[1,3],before:0})).toEqual([['b','d','a','c'],['f','h','e','g'],['j','l','i','k']]);
  });
});
