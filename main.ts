// A tiny stack VM: an interpreter for make.fun's tiny stack ISA v1,
// for the "Build a tiny stack virtual machine" bounty. It runs
// every instance in the input directory and writes stdout.bin and
// exit.txt for it. Bounds (the ISA): 32-bit values that wrap, a stack of
// at most 256 values, 64 return addresses, 256 words of memory,
// 1,000,000 steps, 65,536 output bytes; trap keeps prior output and
// its code becomes the exit code.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_MAX = 65_536;
const INT_MIN = -2147483648;

// Per opcode byte: [immediate bytes, popped, pushed]; no entry: trap 5.
// Binary operators (bytes 16-34 except NEG, NOT) are all [0, 2, 1].
const FACTS: [number, number, number][] = [];
for (let b = 16; b <= 34; b++) if (b !== 23 && b !== 27 && b !== 31) FACTS[b] = [0, 2, 1];
for (const t of [
  [0,0,0,0],[1,1,0,1],[2,4,0,1],[3,0,1,0],[4,0,1,2],[5,0,2,2],[6,0,2,3],[7,0,3,3],[23,0,1,1],
  [27,0,1,1],[48,2,0,0],[49,2,1,0],[50,2,1,0],[51,2,0,0],[52,0,0,0],[64,0,1,1],[65,0,2,0],
  [80,0,1,0],[81,0,1,0],[82,0,0,1],[83,0,1,0],
]) FACTS[t[0]] = [t[1], t[2], t[3]];

// Runs one program: its output bytes and exit code.
function run(prog: Uint8Array, inp: Uint8Array) {
  const st = new Int32Array(256);
  let sp = 0;
  const cs = new Int32Array(64);
  let csp = 0;
  const mem = new Int32Array(256);
  const buf = new Uint8Array(OUT_MAX);
  let len = 0;
  let pc = 0;
  let steps = 0;
  let ip = 0;
  const n = prog.length;
  const end = (code: number) => ({ out: buf.subarray(0, len), code });

  for (;;) {
    // One step, in the ISA's order: step limit, pc range, opcode, immediate, stack.
    if (steps === 1_000_000) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = prog[pc];
    const fact = FACTS[op];
    if (fact === undefined) return end(5);
    const imm = fact[0];
    if (pc + imm >= n) return end(9);
    steps += 1;
    if (sp < fact[1]) return end(2);
    if (sp - fact[1] + fact[2] > 256) return end(3);
    const nx = pc + 1 + imm;
    pc = nx;
    switch (op) {
    case 0x00: return end(0); // HALT
    case 0x01: st[sp++] = (prog[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
    case 0x02: st[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24); break; // PUSH32
    case 0x03: sp -= 1; break; // POP
    case 0x04: st[sp] = st[sp - 1]; sp += 1; break; // DUP
    case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; } // SWAP
    case 0x06: st[sp] = st[sp - 2]; sp += 1; break; // OVER
    case 0x07: { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; } // ROT
    case 0x17: st[sp - 1] = -st[sp - 1] | 0; break; // NEG, wraps
    case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
    case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
    case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
    case 0x20: case 0x21: case 0x22: { // binary operators: ( a b -- r )
      const b = st[sp - 1];
      const a = st[sp - 2];
      let r: number;
      if (op === 0x10) r = a + b;
      else if (op === 0x11) r = a - b;
      else if (op === 0x12) r = Math.imul(a, b); // MUL: low 32 bits of the product
      else if (op === 0x13) { // DIV: toward zero; INT_MIN / -1 is INT_MIN
        if (b === 0) return end(4);
        r = a === INT_MIN && b === -1 ? INT_MIN : (a / b) | 0;
      } else if (op === 0x14) { // MOD: sign of a; x % -1 is 0
        if (b === 0) return end(4);
        r = b === -1 ? 0 : (a % b) | 0;
      } else if (op === 0x15) { // DIVU: a, b read as unsigned
        if (b === 0) return end(4);
        r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
      } else if (op === 0x16) { // MODU
        if (b === 0) return end(4);
        r = (a >>> 0) % (b >>> 0) | 0;
      } else if (op === 0x18) r = a & b;
      else if (op === 0x19) r = a | b;
      else if (op === 0x1a) r = a ^ b;
      else if (op === 0x1c) r = a << (b & 31); // shift counts: low 5 bits only
      else if (op === 0x1d) r = a >> (b & 31); // SHR arithmetic, SHRU logical
      else if (op === 0x1e) r = a >>> (b & 31);
      else if (op === 0x20) r = a === b ? 1 : 0;
      else if (op === 0x21) r = a < b ? 1 : 0; // LT: signed
      else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU: unsigned
      sp -= 1;
      st[sp - 1] = r;
      break;
    }
    case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ: signed offset from the next instruction
      const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
      let go = op === 0x30;
      if (!go) go = (op === 0x31) === (st[--sp] === 0); // JZ takes it when 0, JNZ when not
      if (go) pc = nx + rel;
      break;
    }
    case 0x33: // CALL: the immediate is the unsigned target address
      if (csp === 64) return end(7);
      cs[csp++] = nx;
      pc = prog[nx - 2] | (prog[nx - 1] << 8);
      break;
    case 0x34: // RET
      if (csp === 0) return end(8);
      pc = cs[--csp];
      break;
    case 0x40: { // LOAD
      const addr = st[sp - 1];
      if (addr < 0 || addr >= 256) return end(6);
      st[sp - 1] = mem[addr];
      break;
    }
    case 0x41: { // STORE: ( v addr -- )
      const addr = st[sp - 1];
      if (addr < 0 || addr >= 256) return end(6);
      mem[addr] = st[sp - 2]; sp -= 2; break;
    }
    case 0x50: { // PRINT: decimal ASCII; past the limit it writes nothing, traps 11
      const s = String(st[sp - 1]);
      if (len + s.length > OUT_MAX) return end(11);
      sp -= 1;
      for (let i = 0; i < s.length; i++) buf[len++] = s.charCodeAt(i);
      break;
    }
    case 0x51: // PUTC: one byte, the low 8 bits of the value
      if (len === OUT_MAX) return end(11);
      buf[len++] = st[--sp] & 255;
      break;
    case 0x52: // IN: the next input byte, or -1 once the input is used up
      st[sp++] = ip < inp.length ? inp[ip++] : -1;
      break;
    case 0x53: return end(st[--sp] & 255); // EXIT: the code is the low byte
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  let prog = new Uint8Array(0);
  let inp = new Uint8Array(0);
  try { prog = readFileSync(join(I, id, 'program.bin')); } catch { /* empty: traps 9 */ }
  try { inp = readFileSync(join(I, id, 'input.bin')); } catch { /* none: IN reads -1 */ }
  const { out, code } = run(prog, inp);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), out);
  writeFileSync(join(O, id, 'exit.txt'), `${code}\n`);
}
