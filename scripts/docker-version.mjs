// The build a Docker or Coolify image records in /app/.cubex-version (Dockerfile), in the installer's form
// (server/src/lib/cubex-version.ts): "v0.8.44 6071123" for a commit a release tag names, "main 6071123" for
// another commit. Read from the build context's .git with no git command (the build image has none): HEAD, the
// tags under refs/tags and in packed-refs (an annotated tag's peeled line), a worktree's .git file too.
// CUBEX_VERSION (a build argument) is written as it is; without a .git, SOURCE_COMMIT (Coolify's build argument)
// gives the commit. With neither, nothing: the version isn't recorded, as before.
// Usage: node scripts/docker-version.mjs [dir]   (prints the line, or nothing)
import fs from 'node:fs';
import path from 'node:path';

const TAG = /^v\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const SHA = /^[0-9a-f]{40}$/;
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// The .git folder and the one shared refs live in (a worktree's own, and its common one).
function gitDirs(dir) {
  const dotGit = path.join(dir, '.git');
  let own = dotGit;
  const file = read(dotGit);
  if (file !== null) {
    const m = /^gitdir:\s*(.+)$/m.exec(file);
    if (!m) return null;
    own = path.resolve(dir, m[1].trim());
  } else if (!fs.existsSync(dotGit)) return null;
  const common = read(path.join(own, 'commondir'));
  return { own, common: common ? path.resolve(own, common.trim()) : own };
}

function resolveRef(dirs, ref) {
  for (const d of [dirs.own, dirs.common]) {
    const v = read(path.join(d, ref))?.trim();
    if (v && SHA.test(v)) return v;
  }
  for (const line of (read(path.join(dirs.common, 'packed-refs')) ?? '').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && SHA.test(sha)) return sha;
  }
  return null;
}

// The release tags that name a commit: lightweight ones, and annotated ones by their peeled line (^sha).
function tagsAt(dirs, sha) {
  const tags = new Set();
  const loose = path.join(dirs.common, 'refs', 'tags');
  for (const name of fs.existsSync(loose) ? fs.readdirSync(loose) : []) {
    if (TAG.test(name) && read(path.join(loose, name))?.trim() === sha) tags.add(name);
  }
  let last = null;
  for (const line of (read(path.join(dirs.common, 'packed-refs')) ?? '').split('\n')) {
    if (line.startsWith('^')) {
      if (last && line.slice(1).trim() === sha) tags.add(last);
      continue;
    }
    const [s, name] = line.trim().split(' ');
    last = name?.startsWith('refs/tags/') && TAG.test(name.slice(10)) ? name.slice(10) : null;
    if (last && s === sha) tags.add(last);
  }
  return [...tags];
}

const newest = (tags) => tags.sort((a, b) => {
  const [x, y] = [a, b].map(t => t.slice(1).split('.').map(Number));
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
})[0];

export function dockerVersion(dir, env = process.env) {
  if (env.CUBEX_VERSION?.trim()) return env.CUBEX_VERSION.trim();
  const dirs = gitDirs(dir);
  let sha = null;
  if (dirs) {
    const head = read(path.join(dirs.own, 'HEAD'))?.trim() ?? '';
    sha = head.startsWith('ref: ') ? resolveRef(dirs, head.slice(5)) : (SHA.test(head) ? head : null);
  }
  if (!sha && SHA.test(env.SOURCE_COMMIT?.trim() ?? '')) return `main ${env.SOURCE_COMMIT.trim().slice(0, 7)}`;
  if (!sha) return '';
  const tag = newest(tagsAt(dirs, sha));
  return `${tag ?? 'main'} ${sha.slice(0, 7)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const line = dockerVersion(path.resolve(process.argv[2] ?? '.'));
  if (line) process.stdout.write(`${line}\n`);
}
