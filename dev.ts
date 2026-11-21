/**
 * npm run dev: starts the server and the game screen together, for working
 * on the game.
 *
 *   server  http://localhost:3000   restarts when its code changes
 *   screen  http://localhost:5173   updates in the browser as you edit; it
 *                                   sends /api requests on to the server
 *
 * Open the screen's address. Ctrl+C stops both.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function start(label: string, script: string): ChildProcess {
  const child = spawn(npm, ['run', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const print = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() !== '') console.log(`[${label}] ${line}`);
    }
  };
  child.stdout.on('data', print);
  child.stderr.on('data', print);
  return child;
}

const children = [start('server', 'dev:server'), start('screen', 'dev:web')];

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

// If one of the two stops, stop the other: half a game is no use.
for (const child of children) {
  child.on('exit', (code) => {
    stopAll(code ?? 0);
  });
}
process.on('SIGINT', () => {
  stopAll(0);
});
process.on('SIGTERM', () => {
  stopAll(0);
});
