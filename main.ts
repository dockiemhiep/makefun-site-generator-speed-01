import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Tune V8 for low total process CPU on short 3-case runs: keep incremental marking off
// (matching baseline) and disable expensive TurboFan passes + raise TurboFan threshold so
// compilation CPU doesn't dominate execution CPU.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbo-inlining');
setFlagsFromString('--no-turbo-escape');
setFlagsFromString('--no-turbo-loop-peeling');
setFlagsFromString('--no-turbo-load-elimination');
setFlagsFromString('--no-turbo-store-elimination');
setFlagsFromString('--invocation-count-for-turbofan=10000');
setFlagsFromString('--max-semi-space-size=64');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as ({
  id: string;
  input: unknown;
} | null)[];

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[i]!.input)));
  cases[i] = null;
}
writeSync(fd, ']');
closeSync(fd);
