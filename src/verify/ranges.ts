/**
 * Digest byte-range computation (mirrors the C `SealDigest()`).
 *
 * The `b=` field is a comma-separated list of range specs, each `start~end`.
 * Tokens: `F` (start of file), `f` (file length), `S`/`s` (current signature
 * value start/end), `P`/`p` (previous signature value start/end), literal
 * digits, and `+`/`-` arithmetic from the last token.
 */

export interface ByteRanges {
  ranges: Array<[number, number]> | null;
  error: string | null;
}

export function computeByteRanges(
  bSpec: string,
  fileLen: number,
  sigStart: number,
  sigEnd: number,
  prevStart = 0,
  prevEnd = 0,
): ByteRanges {
  /*
    State machine (mirrors C):
      0 = reading range-start value
      1 = finished reading range-start (saw a letter/digit token)
      2 = reading range-start arithmetic operand
      3 = reading range-end value
      4 = finished reading range-end
      5 = reading range-end arithmetic operand
  */
  const b = bSpec || '';
  const ranges: Array<[number, number]> = [];
  let state = 0,
    acc = 0,
    addsym = 1;
  let sum = [0, 0]; // [range-start, range-end]

  for (let i = 0; i <= b.length; i++) {
    const ch = i < b.length ? b[i] : ','; // treat end-of-string as a final ','

    if (ch === '+') {
      if (state < 3) {
        sum[0] += acc * addsym;
        state = 2;
      } else {
        sum[1] += acc * addsym;
        state = 5;
      }
      addsym = 1;
      acc = 0;
    } else if (ch === '-') {
      if (state < 3) {
        sum[0] += acc * addsym;
        state = 2;
      } else {
        sum[1] += acc * addsym;
        state = 5;
      }
      addsym = -1;
      acc = 0;
    } else if (ch === 'S') {
      if (state < 3) {
        sum[0] += sigStart * addsym;
        state = 1;
      } else {
        sum[1] += sigStart * addsym;
        state = 4;
      }
      addsym = 1;
      acc = 0;
    } else if (ch === 's') {
      if (state < 3) {
        sum[0] += sigEnd * addsym;
        state = 1;
      } else {
        sum[1] += sigEnd * addsym;
        state = 4;
      }
      addsym = 1;
      acc = 0;
    } else if (ch === 'P') {
      if (state < 3) {
        sum[0] += prevStart * addsym;
        state = 1;
      } else {
        sum[1] += prevStart * addsym;
        state = 4;
      }
      addsym = 1;
      acc = 0;
    } else if (ch === 'p') {
      if (state < 3) {
        sum[0] += prevEnd * addsym;
        state = 1;
      } else {
        sum[1] += prevEnd * addsym;
        state = 4;
      }
      addsym = 1;
      acc = 0;
    } else if (ch === 'F') {
      if (state < 3) {
        sum[0] += 0;
        state = 1;
      } else {
        sum[1] += 0;
        state = 4;
      }
      addsym = 1;
      acc = 0;
    } else if (ch === 'f') {
      if (state < 3) {
        sum[0] += fileLen * addsym;
        state = 1;
      } else {
        sum[1] += fileLen * addsym;
        state = 4;
      }
      addsym = 1;
      acc = 0;
    } else if (ch >= '0' && ch <= '9') {
      acc = acc * 10 + (ch.charCodeAt(0) - 48);
      if (state < 3) {state = 0;}
      else {state = 3;}
    } else if (ch === '~') {
      // Switch from range-start to range-end
      sum[0] += acc * addsym;
      acc = 0;
      addsym = 1;
      state = 3;
    } else if (ch === ',') {
      // End of range
      if (state === 3 && acc === 0) {
        sum[1] = fileLen; // implicit end = EOF
      } else {
        sum[1] += acc * addsym;
      }
      // Validate
      if (sum[0] > fileLen || sum[1] > fileLen) {
        return { ranges: null, error: `b="${bSpec}": range ${sum[0]}-${sum[1]} outside file (${fileLen} bytes)` };
      }
      if (sum[1] < sum[0]) {
        return { ranges: null, error: `b="${bSpec}": range end (${sum[1]}) before start (${sum[0]})` };
      }
      if (sum[1] > sum[0]) {
        ranges.push([sum[0], sum[1]]);
      }
      // Reset for next range
      state = 0;
      acc = 0;
      addsym = 1;
      sum = [0, 0];
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      // whitespace: ignore
    } else {
      return { ranges: null, error: `b="${bSpec}": unexpected character '${ch}'` };
    }
  }

  // The final ',' we injected handles any remaining state.
  return { ranges, error: null };
}
