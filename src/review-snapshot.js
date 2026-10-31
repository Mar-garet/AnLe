import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const MAX_PATCH = 64 * 1024 * 1024;
const MAX_UNTRACKED = 32 * 1024 * 1024;

// Git commands never use a shell, hooks, external diff drivers, or an inherited
// alternate index. Snapshot data is private to AnLe and never changes the repo.
function gitEnv() {
  const env = {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LITERAL_PATHSPECS: '1'};
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT']) delete env[name];
  return env;
}

async function git(cwd, args, {maxBuffer = MAX_PATCH} = {}) {
  try {
    return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {env: gitEnv(), encoding: 'buffer', maxBuffer, timeout: 60000})).stdout;
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8').trim() : String(error.stderr || error.message).trim();
    throw new Error(`Git ${args[0]} failed: ${detail.slice(0, 1000)}`);
  }
}

function pathList(buffer) {
  if (!buffer.length) return [];
  const parts = buffer.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (!Buffer.from(parts.join('\0') + '\0').equals(buffer)) throw new Error('Non-UTF-8 file names cannot be captured safely');
  return parts;
}

export function validateReviewPaths(paths = []) {
  if (!Array.isArray(paths) || paths.length > 100) throw new Error('Provide at most 100 repository-relative paths');
  return [...new Set(paths.map(path => {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.git')) throw new Error('Review paths must be repository-relative and cannot include .. or .git');
    const normalized = path.replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized) throw new Error('Review paths cannot be empty');
    return normalized;
  }))];
}

async function readUntracked(root, paths) {
  const names = pathList(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]));
  let total = 0;
  const files = [];
  for (const name of names) {
    const path = resolve(root, name);
    if (relative(root, path).startsWith(`..${sep}`) || path === root) throw new Error('An untracked path is outside the repository');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      files.push({name, mode: 'symlink', target});
    } else if (stat.isFile()) {
      if (total + stat.size > MAX_UNTRACKED) throw new Error('Untracked files exceed the 32 MB snapshot limit; select fewer paths');
      const data = await readFile(path);
      total += data.length;
      if (total > MAX_UNTRACKED) throw new Error('Untracked files exceed the 32 MB snapshot limit; select fewer paths');
      files.push({name, mode: stat.mode & 0o777, data});
    } else throw new Error(`Cannot snapshot untracked directory or special file: ${name}`);
  }
  return files;
}

function fingerprint({head, staged, unstaged, files}) {
  const hash = createHash('sha256');
  const add = value => { const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); hash.update(`${data.length}:`); hash.update(data); };
  add(head); add(staged); add(unstaged);
  for (const file of files) { add(file.name); add(file.mode); add(file.target ?? file.data); }
  return hash.digest('hex');
}

async function capture(root, paths) {
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
  const unmerged = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z', '--', ...paths]);
  if (unmerged.length) throw new Error('Resolve merge conflicts before creating a review snapshot');
  const entries = await git(root, ['ls-files', '--stage', '-z', '--', ...paths]);
  if (pathList(entries).some(entry => entry.startsWith('160000 '))) throw new Error('Review snapshots do not yet support Git submodules in the selected scope');
  const staged = await git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', head, '--', ...paths]);
  const unstaged = await git(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--', ...paths]);
  const files = await readUntracked(root, paths);
  const result = {head, staged, unstaged, files};
  return {...result, fingerprint: fingerprint(result)};
}

async function applyPatch(cwd, patch, staged) {
  if (!patch.length) return;
  await new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, 'apply', ...(staged ? ['--index'] : []), '--binary', '-'], {env: gitEnv(), stdio: ['pipe', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.on('data', data => { if (stderr.length < 2000) stderr += data.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`Could not reproduce ${staged ? 'staged' : 'unstaged'} changes: ${stderr.trim().slice(0, 1000)}`)));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(patch);
  });
}

async function ensureSafeParents(root, filename) {
  let current = root;
  const parts = relative(root, dirname(filename)).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe snapshot parent: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current, {mode: 0o700});
    }
  }
}

export async function repositoryRoot(cwd) {
  if (!cwd || !isAbsolute(cwd)) throw new Error('The session needs an absolute repository directory');
  return realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\r?\n$/, ''));
}

async function canonicalDestination(path) {
  let current = resolve(path);
  const suffix = [];
  while (true) {
    try { return resolve(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

export async function currentReviewFingerprint(cwd, paths = []) {
  const root = await repositoryRoot(cwd);
  return (await capture(root, validateReviewPaths(paths))).fingerprint;
}

export async function createReviewSnapshot({cwd, destination, base, paths = [], allowEmpty = false}) {
  paths = validateReviewPaths(paths);
  const root = await repositoryRoot(cwd);
  const destinationFromRoot = relative(root, await canonicalDestination(destination));
  if (!isAbsolute(destination) || !destinationFromRoot || (!destinationFromRoot.startsWith(`..${sep}`) && destinationFromRoot !== '..') || !basename(destination)) throw new Error('Review snapshots must be stored outside the source repository');
  const baseOid = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base || 'HEAD'}^{commit}`])).toString('utf8').trim();
  const before = await capture(root, paths);
  if (!allowEmpty && baseOid === before.head && !before.staged.length && !before.unstaged.length && !before.files.length) throw new Error('No changes in the selected review scope');
  await mkdir(dirname(destination), {recursive: true, mode: 0o700});
  await mkdir(destination, {mode: 0o700});
  try {
    await git(root, ['clone', '--quiet', '--shared', '--dissociate', '--no-checkout', '--', root, destination]);
    await git(destination, ['checkout', '--quiet', '--detach', before.head]);
    await applyPatch(destination, before.staged, true);
    await applyPatch(destination, before.unstaged, false);
    for (const file of before.files) {
      const target = resolve(destination, file.name);
      if (relative(destination, target).startsWith(`..${sep}`) || target === destination) throw new Error('An untracked path is outside the snapshot');
      await ensureSafeParents(destination, target);
      if (file.mode === 'symlink') await symlink(file.target, target);
      else await writeFile(target, file.data, {mode: file.mode, flag: 'wx'});
    }
    // Capture again so a concurrent edit cannot silently change the review target.
    const after = await capture(root, paths);
    if (after.fingerprint !== before.fingerprint) throw new Error('The working tree changed while creating the snapshot; try again');
    const tracked = pathList(await git(destination, ['diff', '--name-only', '--no-renames', '-z', baseOid, '--', ...paths]));
    const staged = pathList(await git(destination, ['diff', '--cached', '--name-only', '--no-renames', '-z', baseOid, '--', ...paths]));
    // An intent-to-add file becomes untracked when its unstaged patch is applied
    // to the clone, so inspect the snapshot rather than just the source list.
    const untracked = pathList(await git(destination, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]));
    const changedPaths = [...new Set([...tracked, ...staged, ...untracked])];
    if (!allowEmpty && !changedPaths.length) throw new Error('No changes in the selected review scope');
    return {root, snapshotPath: destination, baseOid, headOid: before.head, fingerprint: before.fingerprint, paths, changedPaths, untracked};
  } catch (error) {
    // Only the new AnLe-owned snapshot is removed; the source repo is untouched.
    await rm(destination, {recursive: true, force: true});
    throw error;
  }
}
