// Development: strip server in simulator mode (port 8787) + Vite dev server (port 5173).
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', 'packages/server/src/index.ts', '--source', 'sim', '--scenario', 'scenarios/training-mixed.json'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'dev', '-w', '@oceanic/web'], { stdio: 'inherit', shell: true }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
