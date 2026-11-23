// Tiny stack machine for make.fun's ISA v1 — entry for the
// "Build a tiny stack virtual machine" bounty. Runs the
// program in every input folder, writes its output bytes and
// exit code. A trap keeps prior output; its number is the code.
import * as fs from 'node:fs';
import * as path from 'node:path';

// Opcode shape: [opcode, immediate bytes, taken, left].
const SHAPE: [number, number, number, number][] = [
  [0, 0, 0, 0], [1, 1, 0, 1], [2, 4, 0, 1], [3, 0, 1, 0],
  [4, 0, 1, 2], [5, 0, 2, 2], [6, 0, 2, 3], [7, 0, 3, 3],
  [48, 2, 0, 0], [49, 2, 1, 0], [50, 2, 1, 0], [51, 2, 0, 0],
  [52, 0, 0, 0], [64, 0, 1, 1], [65, 0, 2, 0], [80, 0, 1, 0],
  [81, 0, 1, 0], [82, 0, 0, 1], [83, 0, 1, 0],
  [23, 0, 1, 1], [27, 0, 1, 1],
];
// Other real opcodes: two-in, one-out arithmetic.
for (let op = 16; op <= 34; op++) {
  if (op !== 23 && op !== 27) SHAPE.push([op, 0, 2, 1]);
}
const IMM: number[] = [];
const TAKE: number[] = [];
const LEAVE: number[] = [];
for (const [op, imm, take, leave] of SHAPE) {
  IMM[op] = imm; TAKE[op] = take; LEAVE[op] = leave;
}
const WORD_MIN = -2147483648;

// Run one program; return its bytes and exit code.
function execute(code: Buffer, data: Buffer): [number[], number] {
  const stack: number[] = [];
  const returns: number[] = [];
  const memory = new Array<number>(256).fill(0);
  const written: number[] = [];
  let pc = 0;
  let steps = 0;
  let readAt = 0;
  const finish = (status: number): [number[], number] => [written, status];
  for (;;) {
    // Step order: limit, pc, opcode, immediate, stack.
    if (steps >= 1_000_000) return finish(10);
    if (pc < 0 || pc >= code.length) return finish(9);
    const op = code[pc];
    if (IMM[op] === undefined) return finish(5);
    const immLen = IMM[op];
    if (pc + immLen >= code.length) return finish(9);
    steps += 1;
    const take = TAKE[op];
    if (stack.length < take) return finish(2);
    if (stack.length - take + LEAVE[op] > 256) return finish(3);
    const after = pc + 1 + immLen;
    pc = after;
    if (op === 0) return finish(0); // HALT
    if (op === 1) { // PUSH8: the byte read as signed
      const byte = code[after - 1];
      stack.push(byte >= 128 ? byte - 256 : byte);
    } else if (op === 2) { // PUSH32, little-endian
      stack.push(code.readInt32LE(after - 4));
    } else if (op === 3) stack.pop();
    else if (op === 4) stack.push(stack[stack.length - 1]);
    else if (op === 5) { // SWAP: exchange the top two
      const top = stack.pop()!;
      stack.push(top, stack.pop()!);
    } else if (op === 6) { // OVER
      stack.push(stack[stack.length - 2]);
    } else if (op === 7) { // ROT: ( a b c -- b c a )
      const c = stack.pop()!;
      const b = stack.pop()!;
      const a = stack.pop()!;
      stack.push(b, c, a);
    } else if (op >= 16 && op <= 34) {
      if (op === 23) stack.push(-stack.pop()! | 0); // NEG, wraps
      else if (op === 27) stack.push(~stack.pop()!); // NOT
      else {
        const b = stack.pop()!;
        const a = stack.pop()!;
        let result = 0;
        switch (op) {
          case 16: result = (a + b) | 0; break;
          case 17: result = (a - b) | 0; break;
          case 18: result = Math.imul(a, b); break;
          case 19: // DIV truncates toward zero
            if (b === 0) return finish(4);
            result = a === WORD_MIN && b === -1 ? WORD_MIN : (a / b) | 0;
            break;
          case 20: // MOD takes the sign of a
            if (b === 0) return finish(4);
            result = b === -1 ? 0 : (a % b) | 0;
            break;
          case 21: // DIVU: unsigned reading of both sides
            if (b === 0) return finish(4);
            result = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 22: // MODU
            if (b === 0) return finish(4);
            result = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 24: result = a & b; break;
          case 25: result = a | b; break;
          case 26: result = a ^ b; break;
          case 28: result = a << (b & 31); break;
          case 29: result = a >> (b & 31); break;
          case 30: result = (a >>> (b & 31)) | 0; break;
          case 32: result = a === b ? 1 : 0; break;
          case 33: result = a < b ? 1 : 0; break;
          case 34: result = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
        }
        stack.push(result);
      }
    } else if (op >= 48 && op <= 50) {
      // JMP / JZ / JNZ: signed offset from the next instruction.
      const offset = code.readInt16LE(after - 2);
      let jump = op === 48;
      if (!jump) {
        const value = stack.pop()!;
        jump = op === 49 ? value === 0 : value !== 0;
      }
      if (jump) pc = after + offset;
    } else if (op === 51) { // CALL: unsigned target
      if (returns.length >= 64) return finish(7);
      returns.push(after);
      pc = code.readUInt16LE(after - 2);
    } else if (op === 52) { // RET
      if (returns.length === 0) return finish(8);
      pc = returns.pop()!;
    } else if (op === 64) { // LOAD
      const address = stack.pop()!;
      if (address < 0 || address > 255) return finish(6);
      stack.push(memory[address]);
    } else if (op === 65) { // STORE
      const address = stack.pop()!;
      if (address < 0 || address > 255) return finish(6);
      memory[address] = stack.pop()!;
    } else if (op === 80) { // PRINT: decimal, no newline
      const text = String(stack.pop()!);
      if (written.length + text.length > 65_536) return finish(11);
      for (let i = 0; i < text.length; i++) written.push(text.charCodeAt(i));
    } else if (op === 81) { // PUTC: one low byte
      if (written.length >= 65_536) return finish(11);
      written.push(stack.pop()! & 255);
    } else if (op === 82) { // IN: -1 after the input runs out
      stack.push(readAt < data.length ? data[readAt++] : -1);
    } else if (op === 83) { // EXIT: the code is the low byte
      return finish(stack.pop()! & 255);
    }
  }
}

const inputRoot = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of fs.readdirSync(inputRoot).sort()) {
  let program = Buffer.alloc(0);
  let input = Buffer.alloc(0);
  try { program = fs.readFileSync(path.join(inputRoot, id, 'program.bin')); }
  catch { /* missing program: runs as empty, trap 9 */ }
  try { input = fs.readFileSync(path.join(inputRoot, id, 'input.bin')); }
  catch { /* missing input: IN reads -1 */ }
  const [bytes, status] = execute(program, input);
  fs.mkdirSync(path.join(outputRoot, id), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, id, 'stdout.bin'), Buffer.from(bytes));
  fs.writeFileSync(path.join(outputRoot, id, 'exit.txt'), String(status) + '\n');
}
