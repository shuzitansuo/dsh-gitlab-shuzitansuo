// Background "new activity in my projects" watcher.
//
// GitLab has no cross-project feed for other people's pushes, so the watcher
// walks the member projects the panel already lists and keeps a per-project
// watermark of the newest event id. A first sighting of a project only records
// the watermark, so installing the plugin does not replay old history.

import fs from 'node:fs';
import path from 'node:path';

const MAX_RECORDS = 60;

function emptyState() {
  return { enabled: true, baseline: true, watermark: {}, items: [] };
}

function sanitize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.enabled = raw.enabled !== false;
  state.baseline = raw.baseline === true;
  if (raw.watermark && typeof raw.watermark === 'object') {
    for (const [key, value] of Object.entries(raw.watermark)) {
      const id = Number(value);
      if (Number.isFinite(id) && id >= 0) state.watermark[key] = id;
    }
  }
  if (Array.isArray(raw.items)) {
    state.items = raw.items
      .filter((item) => item && typeof item === 'object' && item.key && item.projectId)
      .slice(0, MAX_RECORDS);
  }
  return state;
}

function makeRecord(project, event) {
  const push = event.push;
  return {
    key: project.id + ':' + event.id,
    eventId: event.id,
    projectId: project.id,
    projectName: project.pathWithNamespace || project.name || String(project.id),
    projectWebUrl: project.webUrl || '',
    authorName: event.authorName || event.authorUsername || '',
    actionName: event.actionName || '',
    ref: push ? push.ref : '',
    refType: push ? push.refType : '',
    commitId: push ? push.commitId : '',
    commitTitle: push ? push.commitTitle : '',
    targetType: event.targetType || '',
    targetIid: event.targetIid || event.targetId || 0,
    targetTitle: event.targetTitle || '',
    createdAt: event.createdAt || '',
    read: false,
  };
}

export function createActivityWatcher(options) {
  const file = options.file;
  const throttleMs = Number(options.throttleMs) > 0 ? Number(options.throttleMs) : 20000;
  const maxProjects = Number(options.maxProjects) > 0 ? Number(options.maxProjects) : 20;
  const maxItems = Number(options.maxItems) > 0 ? Number(options.maxItems) : MAX_RECORDS;
  const concurrency = 4;

  let state = load();
  let lastPollAt = 0;

  function load() {
    try {
      return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      return emptyState();
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      /* a failed write only costs one poll of history */
    }
  }

  function snapshot() {
    return {
      enabled: state.enabled,
      unread: state.items.filter((item) => !item.read).length,
      items: state.items.slice(0, maxItems),
      lastPollAt,
    };
  }

  async function poll(client, { force = false } = {}) {
    if (!state.enabled) return snapshot();
    const now = Date.now();
    if (!force && now - lastPollAt < throttleMs) return snapshot();
    lastPollAt = now;

    let projects = [];
    try {
      const result = await client.projects();
      projects = (result.projects || []).slice(0, maxProjects);
    } catch (error) {
      // Keep the previous list of notifications when GitLab is unreachable.
      lastPollAt = 0;
      return snapshot();
    }

    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < projects.length) {
        const project = projects[cursor];
        cursor += 1;
        try {
          const page = await client.events(project.id, 'all', { perPage: 20, page: 1 });
          results.push({ project, events: page.items || [] });
        } catch (error) {
          /* one unreachable project must not stop the rest */
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    let added = 0;
    const wasBaseline = state.baseline;
    for (const { project, events } of results) {
      const mark = Number(state.watermark[project.id]) || 0;
      let newest = mark;
      for (const event of events) if (event.id > newest) newest = event.id;
      // First sighting of a project (or the first poll after enabling): record
      // the watermark and stay silent about the backlog.
      if (state.baseline || mark === 0) {
        state.watermark[project.id] = newest;
        continue;
      }
      const fresh = events
        .filter((event) => event.id > mark)
        .sort((a, b) => a.id - b.id)
        .slice(-8);
      for (const event of fresh) {
        state.items.unshift(makeRecord(project, event));
        added += 1;
      }
      state.watermark[project.id] = newest;
    }

    if (state.baseline) state.baseline = false;
    if (state.items.length > maxItems) state.items.length = maxItems;
    // Persist the baseline too, otherwise the next run replays everything.
    if (added || wasBaseline) save();
    return snapshot();
  }

  function markRead(keys) {
    const only = Array.isArray(keys) && keys.length ? new Set(keys.map(String)) : null;
    let changed = false;
    for (const item of state.items) {
      if (item.read) continue;
      if (only && !only.has(String(item.key))) continue;
      item.read = true;
      changed = true;
    }
    if (changed) save();
    return snapshot();
  }

  function setEnabled(enabled) {
    state.enabled = Boolean(enabled);
    if (state.enabled) {
      // Re-baseline so a long pause does not arrive as a notification flood.
      state.baseline = true;
      state.watermark = {};
      lastPollAt = 0;
    }
    save();
    return snapshot();
  }

  return { snapshot, poll, markRead, setEnabled };
}
