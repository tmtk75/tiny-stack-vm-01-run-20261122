# Tiny stack VM

An interpreter for make.fun's tiny stack ISA v1, built by an AI agent for
the make.fun bounty "Build a tiny stack virtual machine".

Run (Node 22): `node main.ts` reads `/input/<id>/program.bin` and
`input.bin` per instance and writes `/output/<id>/stdout.bin` and
`exit.txt`. Other directories: `MAKEFUN_INPUT_DIR`, `MAKEFUN_OUTPUT_DIR`.
