'use strict';

// Write a file that never exists at the wrong mode.
//
// The obvious spelling -- `fs.writeFileSync` then `fs.chmodSync` -- follows the umask (0022 on a
// default install, so 0644) and leaves the file world-readable for the window between the two
// calls. That matters here because the files this writes are a recovery phrase, a passphrase and
// the status API's bearer token. Creating the temp file *with* the mode and renaming it into place
// closes the window: a rename does not change the mode, so there is no moment at which a wrong one
// is visible. It also tightens a loose file left behind by an earlier build, since a rename
// replaces the target rather than opening it.
//
// This mirrors what upstream does for the same reason; see `load_or_create_token` in
// pubky-swap/swap-provider/src/status.rs.

const fs = require('fs');
const path = require('path');

/** Write `data` to `file` atomically, created at `mode`. */
function writeAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeSync(fd, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

/** Read a file and trim it, or return '' if it is missing or unreadable. */
function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/**
 * Best-effort overwrite before unlinking.
 *
 * Used on the pre-facelift config.json, which held a plaintext recovery phrase. Honest about its
 * limits: on a copy-on-write or log-structured filesystem the old blocks may well survive, and the
 * phrase is in every backup taken before the update regardless. It costs three lines and removes
 * the copy that is easiest to stumble over.
 */
function scrub(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r+');
      try { fs.writeSync(fd, Buffer.alloc(size, 0x20), 0, size, 0); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  } catch { /* the file may not exist, which is the outcome we want anyway */ }
  try { fs.rmSync(file, { force: true }); } catch {}
}

module.exports = { writeAtomic, readTrimmed, scrub };
