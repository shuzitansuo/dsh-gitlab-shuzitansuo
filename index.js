// Host half of the GitLab project workbench.
//
// Serves same-origin JSON endpoints for the browser panel and owns every
// GitLab HTTP call, so the access token never reaches the page. The token is
// read from the credential store (GITLAB_TOKEN) and falls back to a local
// 0600 settings file when no credential service is mounted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GitLabClient, GitLabError } from './lib/gitlab-api.js';
import { createSettingsStore } from './lib/settings.js';
import { createActivityWatcher } from './lib/activity.js';

export const name = 'dsh-gitlab';

const ROUTE_PREFIX = '/gitlab/api';
// Namespaced so an unrelated GITLAB_TOKEN in the environment cannot answer for
// this plugin; the store's own value still outranks any environment fallback.
const CREDENTIAL_REF = 'DSH_GITLAB_TOKEN';
const DEFAULT_TTL_MS = 30000;
const MAX_CACHE_ENTRIES = 200;
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Files that decide what the running plugin can do. Records their content hash so
// "check for updates" can tell whether the checkout moved on under us.
const TRACKED_FILES = ['index.js', 'client.js', 'lib/gitlab-api.js', 'lib/settings.js', 'package.json'];

function readSnapshot() {
  const files = {};
  for (const rel of TRACKED_FILES) {
    try {
      const buf = fs.readFileSync(path.join(PACKAGE_DIR, rel));
      files[rel] = createHash('sha1').update(buf).digest('hex').slice(0, 12);
    } catch (error) {
      files[rel] = 'missing';
    }
  }
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version || version;
  } catch (error) {
    /* keep the default */
  }
  return { version, files };
}

export function apply(ctx, config = {}) {
  const settings = createSettingsStore();
  const bootSnapshot = readSnapshot();
  const stateDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'gitlab');
  const watcher =
    config.activityWatch === false
      ? null
      : createActivityWatcher({
          file: path.join(stateDir, 'activity.json'),
          throttleMs: Number(config.activityIntervalMs) || 20000,
          maxProjects: Number(config.activityMaxProjects) || 20,
        });
  const cacheTtl = Number(config.cacheTtlMs) > 0 ? Number(config.cacheTtlMs) : DEFAULT_TTL_MS;
  const cache = new Map();
  // Last identity the Host verified, shown by the panel as "connected as".
  let lastUser = null;

  const service = (id) => {
    try {
      return ctx.get(id);
    } catch (error) {
      return undefined;
    }
  };

  function resolveBaseUrl() {
    return String(settings.read().baseUrl || config.baseUrl || '').replace(/\/+$/, '');
  }

  async function resolveToken() {
    const credentials = service('credentials');
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(CREDENTIAL_REF);
        if (hit && hit.value) return { token: String(hit.value), source: 'credentials' };
      } catch (error) {
        /* fall through to the local store */
      }
    }
    const file = settings.read();
    if (file.token) return { token: file.token, source: 'file' };
    if (config.token) return { token: String(config.token), source: 'config' };
    return { token: '', source: 'none' };
  }

  async function makeClient() {
    const baseUrl = resolveBaseUrl();
    const { token, source } = await resolveToken();
    return { client: new GitLabClient({ baseUrl, token }), baseUrl, token, source };
  }

  function invalidate(prefix) {
    for (const key of [...cache.keys()]) {
      if (!prefix || key.startsWith(prefix)) cache.delete(key);
    }
  }

  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await load();
    putCache(key, value);
    return value;
  }

  function putCache(key, value) {
    cache.set(key, { at: Date.now(), value });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (error) {
      throw new GitLabError('GitLab 地址格式不正确，应形如 https://gitlab.example.com');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new GitLabError('GitLab 地址只支持 http:// 或 https://');
    }
    return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
  }

  async function saveSettings(body) {
    const wantsBaseUrl = typeof body.baseUrl === 'string';
    const currentBaseUrl = resolveBaseUrl();
    const nextBaseUrl = wantsBaseUrl ? normalizeBaseUrl(body.baseUrl) : currentBaseUrl;
    if (!nextBaseUrl) throw new GitLabError('请填写 GitLab 地址');

    const clearToken = body.clearToken === true;
    const explicitToken = typeof body.token === 'string' ? body.token.trim() : '';
    const currentToken = clearToken ? '' : (await resolveToken()).token;
    const nextToken = clearToken ? '' : explicitToken || currentToken;

    // Reusing the stored token against a different host would hand the token to
    // whoever that address points at; a new address needs a fresh token.
    if (wantsBaseUrl && nextBaseUrl !== currentBaseUrl && !explicitToken && !clearToken) {
      return { ok: false, code: 'base_url_changed', error: '更换 GitLab 地址需要重新输入访问令牌' };
    }

    // Validate the candidate before writing anything, so a typo cannot replace a
    // working connection with a broken one.
    let user = null;
    if (nextBaseUrl && nextToken) {
      const probe = new GitLabClient({ baseUrl: nextBaseUrl, token: nextToken });
      user = await probe.me();
    }

    if (wantsBaseUrl) settings.write({ baseUrl: nextBaseUrl });

    let tokenSource = (await resolveToken()).source;
    if (clearToken || explicitToken) {
      const credentials = service('credentials');
      let stored = false;
      if (credentials && typeof credentials.set === 'function') {
        try {
          if (nextToken) await credentials.set(CREDENTIAL_REF, nextToken);
          else if (typeof credentials.unset === 'function') await credentials.unset(CREDENTIAL_REF);
          stored = true;
          tokenSource = 'credentials';
        } catch (error) {
          stored = false;
        }
      }
      if (!stored) {
        settings.write({ token: nextToken });
        tokenSource = 'file';
      } else {
        // Do not leave a stale copy in the local file once the store holds it.
        settings.write({ token: '' });
      }
    }

    lastUser = user;
    invalidate();
    return { ok: true, baseUrl: nextBaseUrl, hasToken: Boolean(nextToken), tokenSource, user };
  }

  const readBody = (req, maxBytes = 64 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const json = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  };

  async function handle(req, res, url) {
    const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');
    const method = req.method || 'GET';
    const fresh = url.searchParams.get('fresh') === '1';

    if (method === 'GET' && route === 'config') {
      const baseUrl = resolveBaseUrl();
      const { token, source } = await resolveToken();
      return json(res, 200, {
        ok: true,
        baseUrl,
        configured: Boolean(baseUrl && token),
        tokenSource: source,
        hasToken: Boolean(token),
        user: lastUser,
      });
    }

    if (method === 'GET' && route === 'me') {
      const { client } = await makeClient();
      if (!client.configured) return json(res, 400, { ok: false, error: '还没有填写访问令牌' });
      const user = await client.me();
      lastUser = user;
      return json(res, 200, { ok: true, user, baseUrl: client.baseUrl });
    }

    if (method === 'POST' && route === 'settings') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (error) {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      let result;
      try {
        result = await saveSettings(body);
      } catch (error) {
        const unauthorized = error instanceof GitLabError && error.status === 401;
        return json(res, unauthorized ? 401 : 200, {
          ok: false,
          error: error?.message || String(error),
          code: unauthorized ? 'unauthorized' : 'connect_failed',
          hasToken: Boolean((await resolveToken()).token),
        });
      }
      if (!result.ok) return json(res, 200, result);
      return json(res, 200, Object.assign({ configured: Boolean(result.baseUrl && result.hasToken) }, result));
    }

    if (method === 'GET' && route === 'projects') {
      const { client } = await makeClient();
      if (!client.configured) return json(res, 200, { ok: true, configured: false, projects: [] });
      const search = url.searchParams.get('search') || '';
      const key = 'projects:' + search;
      const load = () => client.projects({ search });
      const result = fresh ? await load() : await cached(key, cacheTtl, load);
      if (fresh) putCache(key, result);
      return json(res, 200, Object.assign({ ok: true, configured: true }, result));
    }

    if (method === 'GET' && route === 'refs') {
      const projectId = Number(url.searchParams.get('projectId') || 0);
      if (!projectId) return json(res, 400, { ok: false, error: 'projectId required' });
      const { client } = await makeClient();
      if (!client.configured) return json(res, 200, { ok: true, configured: false, branches: [], tags: [] });
      const load = async () => {
        const [branches, tags] = await Promise.all([client.branches(projectId), client.tags(projectId)]);
        return {
          branches: branches.branches,
          tags: tags.tags,
          truncated: branches.truncated || tags.truncated,
        };
      };
      const result = fresh ? await load() : await cached('refs:' + projectId, cacheTtl, load);
      if (fresh) putCache('refs:' + projectId, result);
      return json(res, 200, Object.assign({ ok: true, configured: true }, result));
    }

    if (method === 'GET' && route === 'activity') {
      const { client } = await makeClient();
      if (!client.configured || !watcher) {
        return json(res, 200, { ok: true, configured: false, enabled: false, unread: 0, items: [] });
      }
      const snapshot = await watcher.poll(client, { force: url.searchParams.get('force') === '1' });
      return json(res, 200, Object.assign({ ok: true, configured: true }, snapshot));
    }

    if (method === 'POST' && route === 'activity/read') {
      if (!watcher) return json(res, 200, { ok: true, enabled: false, unread: 0, items: [] });
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (error) {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      // No keys means "mark everything read".
      return json(res, 200, Object.assign({ ok: true }, watcher.markRead(body.keys)));
    }

    if (method === 'POST' && route === 'activity/enabled') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (error) {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      if (!watcher) return json(res, 200, { ok: true, enabled: false, unread: 0, items: [] });
      let snapshot = watcher.setEnabled(body.enabled !== false);
      if (snapshot.enabled) {
        const { client } = await makeClient();
        if (client.configured) snapshot = await watcher.poll(client, { force: true });
      }
      return json(res, 200, Object.assign({ ok: true }, snapshot));
    }

    if (method === 'GET' && route === 'update') {
      const latest = readSnapshot();
      const changed = TRACKED_FILES.filter((file) => latest.files[file] !== bootSnapshot.files[file]);
      // Host-side modules only reload with the plugin, the browser half reloads
      // with the page.
      const needsRestart = changed.some((file) => file !== 'client.js');
      return json(res, 200, {
        ok: true,
        version: bootSnapshot.version,
        latestVersion: latest.version,
        changed,
        needsRestart,
        upToDate: changed.length === 0,
      });
    }

    if (method === 'GET' && route === 'overview') {
      const filter = ['push', 'merge'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const { client } = await makeClient();
      if (!client.configured) {
        return json(res, 200, { ok: true, configured: false, filter, page, events: [], hasMore: false });
      }
      // GitLab has no cross-project feed for other people's activity, so the
      // overview fans out per project once and pages through the merged result.
      const merged = await cached('overview:' + filter, cacheTtl, async () => {
        const { projects } = await client.projects();
        const list = (projects || []).slice(0, Number(config.overviewMaxProjects) || 20);
        const collected = [];
        let cursor = 0;
        const worker = async () => {
          while (cursor < list.length) {
            const project = list[cursor];
            cursor += 1;
            try {
              const pageResult = await client.events(project.id, filter, { perPage: 100, page: 1 });
              for (const event of pageResult.items) {
                collected.push(
                  Object.assign({}, event, {
                    projectId: project.id,
                    projectName: project.pathWithNamespace || project.name,
                    projectWebUrl: project.webUrl || '',
                  }),
                );
              }
            } catch (error) {
              /* one unreachable project must not blank the overview */
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        collected.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id - a.id);
        return collected.slice(0, 300);
      });
      const size = 30;
      const offset = (page - 1) * size;
      return json(res, 200, {
        ok: true,
        configured: true,
        filter,
        page,
        total: merged.length,
        events: merged.slice(offset, offset + size),
        hasMore: offset + size < merged.length,
      });
    }

    if (method === 'GET' && route === 'events') {
      const projectId = Number(url.searchParams.get('projectId') || 0);
      const filter = ['push', 'merge'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
      if (!projectId) return json(res, 400, { ok: false, error: 'projectId required' });
      const { client } = await makeClient();
      if (!client.configured) return json(res, 200, { ok: true, configured: false, events: [] });
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const key = `events:${projectId}:${filter}:${page}`;
      const load = () => client.events(projectId, filter, { perPage: 30, page });
      const result = fresh ? await load() : await cached(key, cacheTtl, load);
      if (fresh) putCache(key, result);
      return json(res, 200, {
        ok: true,
        configured: true,
        filter,
        page,
        events: result.items,
        hasMore: result.hasMore,
      });
    }

    if (method === 'GET' && route === 'commits') {
      const projectId = Number(url.searchParams.get('projectId') || 0);
      const ref = url.searchParams.get('ref') || '';
      // Branch and tag names share one namespace on GitLab, so the cache has to
      // tell them apart even though the request is the same.
      const kind = url.searchParams.get('kind') === 'tag' ? 'tag' : 'branch';
      if (!projectId || !ref) return json(res, 400, { ok: false, error: 'projectId and ref are required' });
      const { client } = await makeClient();
      if (!client.configured) return json(res, 200, { ok: true, configured: false, commits: [] });
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const key = `commits:${projectId}:${kind}:${ref}:${page}`;
      const load = async () => {
        const result = await client.commits(projectId, ref, { perPage: 30, page });
        // Tag pills in the list need to know which tags point at which commit.
        let tagMap = {};
        try {
          tagMap = await cached('tagmap:' + projectId, cacheTtl, async () => {
            const { tags } = await client.tags(projectId);
            const map = Object.create(null);
            for (const tag of tags) {
              const id = tag.commit && tag.commit.id;
              if (!id) continue;
              (map[id] || (map[id] = [])).push(tag.name);
            }
            return map;
          });
        } catch (error) {
          tagMap = {};
        }
        return {
          items: result.items.map((commit) => Object.assign({}, commit, { tags: tagMap[commit.id] || [] })),
          hasMore: result.hasMore,
        };
      };
      const result = fresh ? await load() : await cached(key, cacheTtl, load);
      if (fresh) putCache(key, result);
      return json(res, 200, {
        ok: true,
        configured: true,
        page,
        commits: result.items,
        hasMore: result.hasMore,
      });
    }

    return json(res, 404, { ok: false, error: 'unknown endpoint' });
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (req.headers['x-gitlab-client'] !== '1') {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end('{"ok":false,"error":"forbidden"}');
            return;
          }
          // This route holds a GitLab token, so it answers only requests that
          // address the local UI: a rebinding host cannot reach it.
          if (!hostAllowed(req.headers.host)) {
            json(res, 403, { ok: false, error: '只接受本机地址访问，请用 127.0.0.1 打开 DSH' });
            return;
          }
          let url;
          try {
            url = new URL(req.url || '/', 'http://127.0.0.1');
          } catch (error) {
            res.writeHead(400);
            res.end();
            return;
          }
          try {
            await handle(req, res, url);
          } catch (error) {
            if (!res.headersSent) {
              const status = error instanceof GitLabError && error.status >= 400 ? error.status : 500;
              json(res, status, {
                ok: false,
                error: error?.message || String(error),
                code: error instanceof GitLabError && error.status === 401 ? 'unauthorized' : 'request_failed',
              });
            } else {
              res.end();
            }
          }
        },
      }),
    );
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostAllowed(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK_HOSTS.has(name);
}
