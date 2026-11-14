# GitLab 项目工作台（DSH 插件）

把 GitLab 搬进 DSH 侧边栏：左边列出你能访问的项目，点开看到分支和 Tag；右边是这个项目的活动流和提交历史。查一条提交、看谁刚推了什么，不用再切浏览器。

## 它解决什么问题

在 DSH 里写代码时，查 GitLab 往往要切窗口：这条分支最新提交是什么？刚刚那个 Tag 打在哪个提交上？谁动了我的项目？这个插件把这些常用操作收进侧边栏，一次点击就能看到。

## 适合谁

- 日常在 DSH 里干活，又需要频繁回看 GitLab 的人。
- 有一把 GitLab Personal Access Token（`read_api` 权限即可），且 DSH 所在机器能直接访问该 GitLab 实例。

## 不适合谁

- 想建分支、打 Tag、提合并请求的 —— 本插件**只读**，不写任何 GitLab 数据。
- GitLab 在防火墙/VPN 后面，DSH 那台机器连不上的 —— 面板会直接报连接失败。
- 想看文件内容或提交 diff 的 —— 这里只列提交标题与元信息，不展示代码变更。

## 功能

- **项目树**：列出你是成员的项目，展开显示分支与 Tag 及各自数量；点「项目」可按名称正序 / 倒序排序，表头有「全部展开 / 收起」。
- **活动流**：按项目查看活动，`全部` / `推送事件` / `合并事件` 三个筛选，按日期分组，能看到谁推了哪个分支、谁合并了哪个 MR。
- **提交历史**：点任意分支或 Tag，看按日期分组的提交列表（作者头像、提交说明、短 SHA）；被打过 Tag 的提交会显示 Tag 胶囊，点击直达 GitLab。
- **活动通知**：你的项目里有人推代码时，右上角铃铛和 DSH 侧边栏图标会显示未读数；点开是气泡列表，可以随时关闭接收。
- **安全**：令牌存在 DSH 凭据库，不写进配置文件，也不会回传到页面。

## 界面

![界面结构示意](docs/ui-preview.svg)

> 上图是**界面结构示意图**（SVG 绘制，项目名与人名均为虚构），不是实拍截图。真实界面配色、间距与它一致。

## 安装

在 DSH 的 **Plugins** 里选 **Add plugin**，选中本目录；或由 agent 用 `plugin_manager` 的 `install_bundle` 安装本目录。

安装后侧边栏会多出一个分支图标，点开就是工作台。

## 首次连接

面板右侧填 GitLab 地址 + Personal Access Token（`read_api` 即可）。令牌保存到 DSH 凭据库的 `DSH_GITLAB_TOKEN`；没有凭据服务时保存到 `~/.dsh/gitlab/settings.json`（0600）。

Host 侧会先校验再写入，换地址时必须重新输入令牌，避免把已有令牌发到别的地址。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 侧：`/gitlab/api` 同源接口（config / settings / me / projects / refs / commits / events / activity / update），托管所有 GitLab 请求与令牌 |
| `lib/gitlab-api.js` | GitLab REST v4 只读客户端（项目、分支、标签、提交、活动，带分页、超时、错误翻译；不跟随重定向） |
| `lib/settings.js` | 没有凭据服务时的本地兜底存储（0600） |
| `lib/activity.js` | 活动通知：按项目记录事件水位、生成通知、存 `~/.dsh/gitlab/activity.json` |
| `client.js` | 浏览器侧：`sidebar.panellist` 图标 + `main` 面板，左右结构与交互 |
| `cordis.patch.yml` | 插件行与默认 `baseUrl` |

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://gitlab.example.com` | GitLab 实例地址，不带结尾斜杠 |
| `cacheTtlMs` | `30000` | 项目 / 分支 / 提交 / 活动的缓存时长；面板刷新按钮会绕过缓存 |
| `activityWatch` | `true` | 是否启用活动通知的后台检查 |
| `activityIntervalMs` | `20000` | 活动通知的轮询节流间隔 |
| `activityMaxProjects` | `20` | 通知最多覆盖多少个项目 |

令牌不放配置里，见上文。

## 许可证

[MIT](LICENSE) © 2026 mikizhu520
