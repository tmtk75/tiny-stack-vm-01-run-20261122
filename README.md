# Tiny stack VM

A stack-machine interpreter for make.fun's ISA v1, for the
tiny-stack-vm-01 bounty. With Node 22, `node main.ts` runs
each `/input/<id>/` program and writes its `stdout.bin` and
`exit.txt` under `/output/<id>/` (dirs settable via
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`).
