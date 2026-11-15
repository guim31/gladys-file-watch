// -----------------------------------------------------------------------------
// One scan of a watched path: the metadata of its files (name, size, times,
// inode), never their content. Periodic scanning rather than inotify: inotify
// sees nothing of what another machine writes on an NFS or SMB share, and a
// scan of 10 000 files takes well under a second on a local disk.
//
//   - symbolic links are skipped (no loop, nothing outside the watch root);
//   - folders deeper than `maxDepth` are not entered (1: the files of the
//     watched folder only);
//   - `maxFiles` bounds the memory (the container has 256 MB): beyond, the
//     scan stops and says it is truncated;
//   - a file's "arrival" time is the latest of its modification and change
//     times: a copy that keeps the original modification date (rsync -a, cp -p)
//     still gets a fresh change time on the destination.
// -----------------------------------------------------------------------------

import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { matchesAny } from './glob.js';

export const LATEST_COUNT = 10;
export const MAX_FILES = 100_000;
// New files remembered per scan (the newest), for the scene events.
export const MAX_ADDED = 1000;
const STAT_CONCURRENCY = 16;
// A file dated more than a day ahead of the clock (a camera with a wrong
// date) must not hide the next real arrivals.
const FUTURE_TOLERANCE_MS = 24 * 3600_000;
// The newest arrival remembered (the floor of the new files) only takes the
// files dated at most a few minutes ahead: one file dated hours ahead would
// hide every real arrival until then.
const WATERMARK_TOLERANCE_MS = 5 * 60_000;

export const defaultFs = { lstat, readdir, stat };

/** Keep `list` as the `count` greatest items by `at` (sorted, newest first). */
function keepNewest(list, item, count) {
  if (list.length === count && item.at <= list[count - 1].at) {
    return;
  }
  let index = list.findIndex((other) => item.at > other.at);
  if (index === -1) {
    index = list.length;
  }
  list.splice(index, 0, item);
  if (list.length > count) {
    list.pop();
  }
}

const isUnknown = (entry) =>
  !(
    entry.isFile() ||
    entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.isFIFO() ||
    entry.isSocket() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice()
  );

// Nanoseconds when available (bigint stats): two files written in the same
// millisecond still compare.
const ms = (stats, name) =>
  stats[`${name}Ns`] !== undefined ? Number(stats[`${name}Ns`]) / 1e6 : Number(stats[`${name}Ms`]);
const arrival = (stats) => Math.max(ms(stats, 'mtime'), ms(stats, 'ctime'));

/**
 * @param {string} absolute path in the container
 * @param {object} options
 * @param {ReturnType<import('./glob.js').compilePatterns>} options.include
 * @param {ReturnType<import('./glob.js').compilePatterns>} options.exclude
 * @param {number} options.maxDepth
 * @param {Map<string,string>|null} options.previous identities of the last scan, by relative path
 * @param {number|null} options.since without `previous`: files arrived after it are new
 * @param {number} options.now
 * @param {number} [options.maxFiles]
 * @param {object} [options.fs] file system seam
 */
export async function scanPath(
  absolute,
  {
    include,
    exclude,
    maxDepth,
    previous = null,
    since = null,
    now,
    maxFiles = MAX_FILES,
    fs = defaultFs,
  },
) {
  let root;
  try {
    // The watched path itself may be a link (to another folder of /data/watch).
    root = await fs.stat(absolute, { bigint: true });
  } catch (err) {
    return { accessible: false, code: err.code ?? 'EIO' };
  }

  const result = {
    accessible: true,
    kind: root.isDirectory() ? 'dir' : 'file',
    files: 0,
    bytes: 0,
    lastAt: null,
    arrivedAt: null,
    latest: [],
    added: [],
    addedCount: 0,
    inodes: new Map(),
    truncated: false,
    unreadable: 0,
  };

  const visit = (relative, stats) => {
    const at = arrival(stats);
    const size = Number(stats.size);
    // A rename keeps the device, the inode, the size and the modification
    // time; a new file that reuses a freed inode does not keep the last two.
    const ino = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs ?? stats.mtimeMs}`;
    result.files += 1;
    result.bytes += size;
    result.inodes.set(relative, ino);
    if (at <= now + WATERMARK_TOLERANCE_MS) {
      result.arrivedAt = result.arrivedAt === null ? at : Math.max(result.arrivedAt, at);
    }
    if (at <= now + FUTURE_TOLERANCE_MS) {
      result.lastAt = result.lastAt === null ? at : Math.max(result.lastAt, at);
      keepNewest(result.latest, { relative, at, size }, LATEST_COUNT);
    }
    const isNew = previous ? !previous.has(relative) : since !== null && at > since;
    if (isNew) {
      result.addedCount += 1;
      keepNewest(result.added, { relative, at, size, ino }, MAX_ADDED);
    }
  };

  if (!root.isDirectory()) {
    if (!root.isFile()) {
      return { accessible: false, code: 'ENOTFILE' };
    }
    visit(basename(absolute), root);
    return result;
  }

  // Depth-first, one folder at a time: bounded memory whatever the tree.
  const stack = [{ dir: absolute, relative: '', depth: 1 }];
  let first = true;
  while (stack.length > 0 && !result.truncated) {
    const { dir, relative, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (first) {
        return { accessible: false, code: err.code ?? 'EIO' };
      }
      if (err.code !== 'ENOENT') {
        result.unreadable += 1;
      }
      continue;
    }
    first = false;
    const files = [];
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (matchesAny(exclude, child)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          stack.push({ dir: join(dir, entry.name), relative: child, depth: depth + 1 });
        }
      } else if (entry.isFile() || isUnknown(entry)) {
        // An unknown type (some network file systems): the lstat below settles it.
        files.push({ path: join(dir, entry.name), relative: child, known: entry.isFile() });
      }
    }
    for (let at = 0; at < files.length && !result.truncated; at += STAT_CONCURRENCY) {
      const batch = files.slice(at, at + STAT_CONCURRENCY);
      const stats = await Promise.all(
        batch.map((file) => fs.lstat(file.path, { bigint: true }).catch(() => null)),
      );
      batch.forEach((file, index) => {
        const entry = stats[index];
        if (!entry || result.truncated) {
          return; // deleted since the listing
        }
        if (entry.isDirectory()) {
          if (!file.known && depth < maxDepth) {
            stack.push({ dir: file.path, relative: file.relative, depth: depth + 1 });
          }
          return;
        }
        if (!entry.isFile()) {
          return;
        }
        if (include.length > 0 && !matchesAny(include, file.relative)) {
          return;
        }
        if (result.files >= maxFiles) {
          result.truncated = true;
          return;
        }
        visit(file.relative, entry);
      });
    }
  }
  return result;
}
