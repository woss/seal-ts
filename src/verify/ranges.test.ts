/**
 * Unit tests for b= byte-range computation (computeByteRanges).
 */
import { describe, expect, it } from 'vitest';

import { computeByteRanges } from './ranges.js';

describe('computeByteRanges', () => {
  it('computes F~f as the whole file', () => {
    expect(computeByteRanges('F~f', 100, 10, 20)).toEqual({ ranges: [[0, 100]], error: null });
  });

  it('blanks the signature value', () => {
    expect(computeByteRanges('F~S,s~f', 100, 10, 20)).toEqual({
      ranges: [
        [0, 10],
        [20, 100],
      ],
      error: null,
    });
  });

  it('uses previous-signature tokens', () => {
    expect(computeByteRanges('P~p', 100, 10, 20, 30, 40)).toEqual({ ranges: [[30, 40]], error: null });
  });

  it('supports signature tokens alone', () => {
    expect(computeByteRanges('S~s', 100, 10, 20)).toEqual({ ranges: [[10, 20]], error: null });
  });

  it('supports arithmetic with + and -', () => {
    expect(computeByteRanges('10+20~50-5', 100, 0, 0)).toEqual({ ranges: [[30, 45]], error: null });
    expect(computeByteRanges('f-10~f', 100, 0, 0)).toEqual({ ranges: [[90, 100]], error: null });
  });

  it('defaults an empty end to file length', () => {
    expect(computeByteRanges('F~', 100, 10, 20)).toEqual({ ranges: [[0, 100]], error: null });
  });

  it('accepts pure literals and whitespace', () => {
    expect(computeByteRanges(' 10 ~ 20 ', 100, 0, 0)).toEqual({ ranges: [[10, 20]], error: null });
  });

  it('skips zero-length ranges', () => {
    expect(computeByteRanges('5~5', 100, 0, 0)).toEqual({ ranges: [], error: null });
  });

  it('rejects ranges outside the file', () => {
    expect(computeByteRanges('f+1~f', 100, 0, 0).error).toMatch(/outside file/);
  });

  it('rejects inverted ranges', () => {
    expect(computeByteRanges('10~5', 100, 0, 0).error).toMatch(/before start/);
  });

  it('rejects unexpected characters', () => {
    expect(computeByteRanges('10~2x', 100, 0, 0).error).toMatch(/unexpected character 'x'/);
  });

  it('uses prevStart/prevEnd in end position', () => {
    expect(computeByteRanges('0~P', 10, 5, 7, 2, 3).ranges).toEqual([[0, 2]]);
    expect(computeByteRanges('0~p', 10, 5, 7, 2, 3).ranges).toEqual([[0, 3]]);
  });
});
