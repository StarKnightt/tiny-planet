// Child-process helpers for the capture pipeline: every child we start is registered here and killed
// synchronously on process exit (normal exit, process.exit() from a teardown, Ctrl-C, crash), so an
// ffmpeg encoder can never outlive the tool that started it.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const children = new Set();
const tempFiles = new Set();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  // 'exit' handlers must be synchronous: kill() is (TerminateProcess on Windows), rmSync is.
  process.on('exit', () => {
    for (const c of children) {
      try { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); } catch {}
    }
    for (const f of tempFiles) {
      try { fs.rmSync(f, { force: true, recursive: true }); } catch {}
    }
  });
}

/** A path that is deleted on exit unless `keepTemp(path)` is called first (i.e. on success). */
export function tempPath(p) {
  install();
  tempFiles.add(p);
  return p;
}
export function keepTemp(p) {
  tempFiles.delete(p);
}

/**
 * Spawn a tracked child (attached: never detached, so it dies with us). Runs at below-normal priority so the
 * machine stays usable during long encodes. Collects the last ~8 KB of stderr for error messages.
 */
export function spawnTracked(cmd, args, opts = {}) {
  install();
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...opts });
  children.add(child);
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let tail = '';
  child.stderr?.on('data', (d) => {
    tail = (tail + d.toString()).slice(-8192);
  });
  child.stderrTail = () => tail;
  child.done = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
    child.on('error', (e) => {
      children.delete(child);
      tail += `\nspawn error: ${e.message}`;
      resolve({ code: -1, signal: null });
    });
  });
  return child;
}

/** Run a command to completion (tracked, so Ctrl-C kills it too). Rejects with stderr on failure. */
export async function run(cmd, args, { input } = {}) {
  const child = spawnTracked(cmd, args);
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const { code } = await child.done;
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')}\n  exited with ${code}\n${child.stderrTail()}`);
  return out;
}

/** Synchronous check that a binary exists on PATH. */
export function haveBinary(cmd) {
  const r = spawnSync(cmd, ['-version'], { windowsHide: true });
  return r.status === 0;
}
