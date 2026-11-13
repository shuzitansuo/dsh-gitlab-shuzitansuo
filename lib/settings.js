// Local fallback store for the GitLab connection settings.
//
// The token belongs in the credential store (see index.js); this file is only
// used when no credential service is mounted. It lives outside the profile
// config and is written with 0600 so a token never lands in cordis.patch.yml.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function settingsDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'gitlab');
}

function settingsPath() {
  return path.join(settingsDir(), 'settings.json');
}

export function createSettingsStore() {
  let cached = null;

  function read() {
    if (cached) return cached;
    try {
      const raw = fs.readFileSync(settingsPath(), 'utf8');
      const parsed = JSON.parse(raw);
      cached = {
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
        token: typeof parsed.token === 'string' ? parsed.token : '',
      };
    } catch (error) {
      cached = { baseUrl: '', token: '' };
    }
    return cached;
  }

  function write(patch) {
    const next = Object.assign({}, read(), patch);
    const dir = settingsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = settingsPath();
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      /* best effort on filesystems without POSIX modes */
    }
    cached = next;
    return next;
  }

  return { read, write, path: settingsPath };
}
