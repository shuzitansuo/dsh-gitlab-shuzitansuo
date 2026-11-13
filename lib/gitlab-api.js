// GitLab REST v4 client.
// Only the handful of read endpoints the panel needs: identity, projects,
// branches, tags and commits. Errors are turned into messages the panel can
// show as-is.

const API = '/api/v4';
const REQUEST_TIMEOUT_MS = 15000;

export class GitLabError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitLabError';
    this.status = status || 0;
  }
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function errorMessage(status, payload) {
  if (status === 401) return '访问令牌无效或已过期，请在「连接设置」里重新填写';
  if (status === 403) return '这个令牌没有读取该资源的权限（需要 read_api）';
  if (status === 404) return 'GitLab 上找不到这个资源，确认地址和权限';
  if (status === 429) return '请求过于频繁，GitLab 正在限流，稍后再试';
  const detail = payload && (payload.message || payload.error);
  if (typeof detail === 'string' && detail) return `GitLab 返回 ${status}：${detail}`;
  return `GitLab 返回 HTTP ${status}`;
}

export class GitLabClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = normalizeBase(baseUrl);
    this.token = String(token || '');
  }

  get configured() {
    return Boolean(this.baseUrl && this.token);
  }

  async request(path, { query, perPage = 100, page = 1 } = {}) {
    let url;
    try {
      url = new URL(this.baseUrl + API + path);
    } catch (error) {
      throw new GitLabError('GitLab 地址格式不正确，应形如 https://gitlab.example.com');
    }
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));

    let res;
    try {
      res = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': this.token, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Never let the token ride along to wherever a redirect points.
        redirect: 'error',
      });
    } catch (error) {
      const cause = (error && error.cause) || error;
      const code = cause && cause.code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        throw new GitLabError(`解析不到 GitLab 地址：${this.baseUrl}`);
      }
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        throw new GitLabError(`连不上 GitLab：${this.baseUrl}（${code}）`);
      }
      if (error && error.name === 'TimeoutError') {
        throw new GitLabError('请求 GitLab 超时，检查网络或实例地址');
      }
      if (cause && typeof cause.code === 'string' && cause.code.startsWith('CERT_')) {
        throw new GitLabError('HTTPS 证书校验失败：' + (cause.message || '请换用受信任的地址'));
      }
      if (cause && cause.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
        throw new GitLabError('HTTPS 使用了自签名证书，Node 无法校验，请换用受信任的地址');
      }
      if (cause && /redirect/i.test(String(cause.message || ''))) {
        throw new GitLabError('GitLab 地址发生了重定向：请把地址改成重定向后的最终地址（不会跟随跳转发送令牌）');
      }
      throw new GitLabError(`请求 GitLab 失败：${(cause && cause.message) || (error && error.message) || error}`);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = null;
      }
    }
    if (!res.ok) throw new GitLabError(errorMessage(res.status, data), res.status);

    const nextPage = Number(res.headers.get('x-next-page') || 0);
    const total = Number(res.headers.get('x-total') || 0);
    return { data, nextPage: Number.isFinite(nextPage) ? nextPage : 0, total };
  }

  /** Follow x-next-page until exhausted or the page cap is hit. */
  async list(path, { query, perPage = 100, maxPages = 3 } = {}) {
    const items = [];
    let page = 1;
    let truncated = false;
    for (let index = 0; index < maxPages; index += 1) {
      const { data, nextPage } = await this.request(path, { query, perPage, page });
      if (Array.isArray(data)) items.push(...data);
      if (!nextPage) return { items, truncated };
      page = nextPage;
      if (index === maxPages - 1) truncated = true;
    }
    return { items, truncated };
  }

  async me() {
    const { data } = await this.request('/user', { perPage: 1 });
    return { id: data.id, username: data.username, name: data.name, avatarUrl: data.avatar_url || '' };
  }

  async projects({ search = '' } = {}) {
    const { items, truncated } = await this.list('/projects', {
      query: {
        membership: true,
        simple: false,
        archived: false,
        order_by: 'last_activity_at',
        sort: 'desc',
        search: search || undefined,
      },
      perPage: 100,
      maxPages: 2,
    });
    return { projects: items.map(normalizeProject), truncated };
  }

  async branches(projectId) {
    const { items, truncated } = await this.list(`/projects/${encodeURIComponent(projectId)}/repository/branches`, {
      perPage: 100,
      maxPages: 3,
    });
    return { branches: items.map(normalizeBranch), truncated };
  }

  async tags(projectId) {
    const { items, truncated } = await this.list(`/projects/${encodeURIComponent(projectId)}/repository/tags`, {
      perPage: 100,
      maxPages: 3,
    });
    return { tags: items.map(normalizeTag), truncated };
  }

  /**
   * Project activity. `filter` mirrors the GitLab Activity page tabs:
   * all | push | merge.
   */
  async events(projectId, filter, { perPage = 30, page = 1 } = {}) {
    const query = {};
    if (filter === 'push') query.action = 'pushed';
    else if (filter === 'merge') query.target_type = 'merge_request';
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/events`, { query, perPage, page });
    return {
      items: (Array.isArray(res.data) ? res.data : []).map(normalizeEvent),
      hasMore: res.nextPage > 0,
    };
  }

  async commits(projectId, ref, { perPage = 30, page = 1 } = {}) {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/repository/commits`, {
      query: { ref_name: ref },
      perPage,
      page,
    });
    return {
      items: (Array.isArray(res.data) ? res.data : []).map(normalizeCommit),
      hasMore: res.nextPage > 0,
    };
  }
}

export function normalizeEvent(event) {
  const author = event.author || {};
  const push = event.push_data || null;
  return {
    id: Number(event.id) || 0,
    actionName: String(event.action_name || ''),
    targetType: String(event.target_type || ''),
    targetIid: Number(event.target_iid) || 0,
    targetId: Number(event.target_id) || 0,
    targetTitle: String(event.target_title || ''),
    authorName: String(author.name || author.username || ''),
    authorUsername: String(author.username || ''),
    createdAt: String(event.created_at || ''),
    push: push
      ? {
          ref: String(push.ref || ''),
          refType: String(push.ref_type || ''),
          commitTitle: String(push.commit_title || ''),
          commitId: String(push.commit_to || ''),
          commitShortId: String(push.commit_to || '').slice(0, 8),
          commitCount: Number(push.commit_count) || 0,
        }
      : null,
  };
}

export function normalizeCommit(commit) {
  if (!commit) return null;
  const message = String(commit.message || '');
  return {
    id: String(commit.id || ''),
    shortId: String(commit.short_id || (commit.id || '').slice(0, 8)),
    title: String(commit.title || message.split('\n')[0] || ''),
    authorName: String(commit.author_name || ''),
    committedDate: String(commit.committed_date || commit.created_at || ''),
    webUrl: String(commit.web_url || ''),
  };
}

export function normalizeProject(project) {
  return {
    id: Number(project.id),
    name: String(project.name || project.path || ''),
    path: String(project.path || ''),
    pathWithNamespace: String(project.path_with_namespace || ''),
    nameWithNamespace: String(project.name_with_namespace || project.name || ''),
    description: String(project.description || ''),
    defaultBranch: String(project.default_branch || ''),
    visibility: String(project.visibility || ''),
    archived: Boolean(project.archived),
    webUrl: String(project.web_url || ''),
    lastActivityAt: String(project.last_activity_at || ''),
  };
}

export function normalizeBranch(branch) {
  return {
    name: String(branch.name || ''),
    protected: Boolean(branch.protected),
    merged: Boolean(branch.merged),
    default: Boolean(branch.default),
    commit: normalizeCommit(branch.commit),
  };
}

export function normalizeTag(tag) {
  return {
    name: String(tag.name || ''),
    message: String(tag.message || ''),
    protected: Boolean(tag.protected),
    commit: normalizeCommit(tag.commit),
  };
}
