// -----------------------------------------------------------------------------
// Glob patterns of the include / exclude lists, the gitignore way:
//
//   - a pattern without "/" is matched against the name alone, at any depth
//     (`*.mkv`, `@eaDir`, `.*`);
//   - a pattern with a "/" is matched against the path relative to the watched
//     folder (`daily/*.tar.gz`, `**/cache/**`); a leading "/" anchors it there
//     too, a trailing "/" is ignored;
//   - `*` and `?` never cross a "/", `**` does, `[abc]`, `[a-z]`, `[!abc]`;
//   - case-insensitive: the shares of a NAS often come from Windows.
//
// The exclusions apply to folders too (an excluded folder is not entered) and
// the inclusions to files only.
// -----------------------------------------------------------------------------

const escape = (char) => char.replace(/[.+^${}()|\\]/g, '\\$&');

/** @returns {RegExp} the regular expression of one glob pattern */
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) {
        body = body.slice(1);
      }
      source += `[${negated ? '^/' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else {
      source += escape(char);
    }
  }
  try {
    return new RegExp(`^${source}$`, 'i');
  } catch {
    // An invalid class such as [z-a]: the pattern is taken literally.
    return new RegExp(`^${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  }
}

/**
 * @param {string[]} patterns
 * @returns {{ regex: RegExp, path: boolean, text: string }[]}
 */
export function compilePatterns(patterns) {
  return patterns
    .map((text) => text.trim())
    .filter((text) => text && text !== '/')
    .map((text) => {
      const cleaned = text.replace(/\/+$/, '');
      const path = cleaned.includes('/');
      return { regex: globToRegExp(cleaned.replace(/^\/+/, '')), path, text };
    });
}

/**
 * Whether a relative path matches one of the compiled patterns.
 * @param {ReturnType<typeof compilePatterns>} compiled
 * @param {string} relative path relative to the watched folder, "/" separated
 */
export function matchesAny(compiled, relative) {
  if (compiled.length === 0) {
    return false;
  }
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  return compiled.some(({ regex, path }) => regex.test(path ? relative : name));
}
