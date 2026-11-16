import { describe, expect, it } from 'vitest';
import { deleteSelectionFills, remapTableFills, tableFormatCells } from './table-fill';

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

describe('table format selection', () => {
  const keys = (cells: ReturnType<typeof tableFormatCells>) => cells?.map(({ row, col }) => `${row}:${col}`);
  it('formats nonadjacent rows and columns without touching the gaps', () => {
    expect(keys(tableFormatCells(3, 3, [], { kind: 'axes', axis: 'row', indices: [2, 0] }))).toEqual(['0:0','0:1','0:2','2:0','2:1','2:2']);
    expect(keys(tableFormatCells(3, 3, [], { kind: 'axes', axis: 'col', indices: [0, 2] }))).toEqual(['0:0','0:2','1:0','1:2','2:0','2:2']);
  });
  it('includes an intersected merged cell without filling other cells in its row or column', () => {
    expect(keys(tableFormatCells(4, 3, [[0,1,2,2]], { kind: 'axes', axis: 'row', indices: [1, 3] }))).toEqual(['0:1','0:2','1:0','1:1','1:2','3:0','3:1','3:2']);
    expect(keys(tableFormatCells(3, 4, [[0,0,2,2]], { kind: 'axes', axis: 'col', indices: [1, 3] }))).toEqual(['0:0','0:1','0:3','1:0','1:1','1:3','2:1','2:3']);
  });
  it('rejects invalid indices and malformed ranges before any write', () => {
    expect(tableFormatCells(3, 3, [], { kind: 'axes', axis: 'row', indices: [] })).toBeNull();
    expect(tableFormatCells(3, 3, [], { kind: 'axes', axis: 'col', indices: [1, 1] })).toBeNull();
    expect(tableFormatCells(3, 3, [], { kind: 'axes', axis: 'row', indices: [3] })).toBeNull();
    expect(tableFormatCells(3, 3, [], { kind: 'range', range: { r0: 0, r1: 3, c0: 0, c1: 1 } })).toBeNull();
    expect(tableFormatCells(3, 3, [[2,2,2,1]], { kind: 'axes', axis: 'row', indices: [2] })).toBeNull();
  });
});
