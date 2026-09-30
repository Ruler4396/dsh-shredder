# dsh-shredder（碎纸机）

在 DeepSeek Harness 自己的会话菜单里加一枚红色的**彻底删除**行，用来把已经归档的会话真正删掉。

本插件是 [DeepSeek Harness](https://www.deepseek.com/)（`dsh`）的社区插件，不是 DeepSeek AI 官方产品。
简体中文说明与 [English README](README.md) 内容对应。

## 它做什么

- 在原生会话行的「…」菜单里加一行，位置就在官方**取消归档**下面。
- **只有该会话已归档时这一行才出现**——普通会话的菜单里看不到删除入口。
- 两步内联确认：第一下变成「确认彻底删除」，第二下才删；菜单一收就复位。
- 删完即从所有界面消失：工作区列表、未分组、归档集。
- 如果日志文件早就不在了、只剩归档集里的 id（幽灵归档记录），同一枚行就只帮你把记录摘掉，并在行为上说明。

## 它故意不做什么

- **不做归档面板、不加页面、不占侧栏。** 归档会话由 dsh 官方直接显示在它所属的工作区下，视图选项里还有「隐藏 / 显示 / 只看已归档」三档筛选。本插件只补官方没给的那一个动作，并且放在动作该在的地方。
- **不做批量删除、搜索、预览、恢复并打开。** 要"归档工作台"请看文末的替代品。
- **没有回收站，不能撤销。** 这里的"碎纸"指把会话目录从文件系统里 unlink，**不做磁盘覆写**；真要找回最多靠文件恢复工具。

## 环境要求

- 实测通过 dsh **0.2.0-rc.2**。更老的宿主有退路（它们没有公开的 `unarchiveSession`），但只有当前这一版是被量过的。
- 一个会装载 bundle 的 profile（出厂的 `desktop` / `web` 都行）。

## 安装

1. 把本仓 clone 到一个稳定位置，例如 `C:\plugins\dsh-shredder`。
2. 在 profile 清单 `~/.dsh/profiles/<profile>/package.json` 里同时加两处：

   ```jsonc
   {
     "dependencies": { "dsh-shredder": "file:C:/plugins/dsh-shredder" },
     "dsh": { "profile": { "bundles": [ /* …已有条目…, */ "dsh-shredder" ] } }
   ```

3. 用 dsh 自带的 pnpm 安装，然后**重启 dsh**（bundle 组合只在启动时解析，刷新页面不够）：

   ```powershell
   & "<dsh 安装目录>\resources\runtime\pnpm\bin\pnpm.cjs" --dir "$HOME\.dsh\profiles\<profile>" add "file:C:/plugins/dsh-shredder"
   ```

   桌面端的 profile 名是 `desktop`；那里 `dsh --profile desktop --dump-config` 会被拒（`profile "desktop" is managed exclusively by the Electron application`），所以校验方式是重启后直接打开一个归档会话的菜单。

4. 打开某个已归档会话的「…」菜单 → **彻底删除** → 点两下。

### 改过源码之后怎么同步

`file:` 依赖装进去的是**拷贝不是链接**。把安装副本删掉之后再跑 `pnpm install`（哪怕加 `--force`）**不会补拷**——它只回一句 `Already up to date`，插件就此没挂载，而 profile 里两行声明看着完全正常。要重发声明本身，并且比字节：

```powershell
Remove-Item "$HOME\.dsh\profiles\<profile>\node_modules\dsh-shredder" -Recurse -Force
& "<pnpm.cjs>" --dir "$HOME\.dsh\profiles\<profile>" add "file:C:/plugins/dsh-shredder"   # 必须打印 `Packages: +1`
```

然后逐枚 sha256 对比两边的 `lib/*.js`，再重启。

### 卸载

`dependencies` 与 `dsh.profile.bundles` 两处条目都移除 + 再跑一次安装 + 重启。
只想暂时不挂载：只摘 `bundles` 那一行即可（bundle 层根本不参与组合）。**别**为此在用户层加
`- id: shredder / disabled: true`——目标 id 不在树里时，那条只会让每次启动往 stderr 打一行
`patch: entry "shredder" not found`，把"没挂上"伪装成"挂上又关掉了"。

## 它是怎么工作的

| 半 | 文件 | 职责 |
| --- | --- | --- |
| 宿主半 | `lib/index.js` | 一枚仅环回监听的 HTTP JSON 端点 |
| 浏览器半 | `lib/client.js` | 菜单行，注入 `sidebar.workspaces.session.menu.item`，`order: 450` |
| 挂载 | `cordis.patch.yml` | bundle 层 `insert` 行（`id: shredder`） |

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| POST | `/dsh-shredder/delete` | `{ sessionId }` | `{ ok, action: 'deleted' \| 'record-only', … }` |

删除顺序本身就是正确性的一部分：

1. 请各所有者停手——官方 `workspace/session-stop` 缝（agent 回合、jobs、subagent、schedule 各自应答）。
2. `flush` 活会话，把缓冲事件落到盘上。
3. 从会话存储里驱逐驻留实例：各标签页立即删行，且不再有迟来写入能把目录重建起来。
4. `WorkspaceEntity.detachSession` 摘掉工作区成员槽。归档**故意**保留成员槽（这样取消归档才能回到原位），所以先删文件、后摘槽会让会话在移出归档集的一瞬闪回工作区列表。
5. 删除 `<会话根>/<项目>/<id>/`。
6. 取消归档（官方 `workspaceRegistry.unarchiveSession`），清掉归档记录。
7. 后台 +2s / +6s / +15s 三次静默复查，被迟来 flush 重建的目录再删一次。

## 已知边界

- **不可恢复。** 要留的东西先导出。
- **有时候那一行不会立刻消失，归档标记是被故意留下的。** 只有"各标签页都已经把这行摘掉"之后清归档记录才有意义。驻留实例被同步驱逐时（广播了 `session/disposed`）这一点是保证的；但实例当时正忙（宿主把分离延后）或本进程根本没有这个实例时，清标记会让一行**还挂在界面上**的会话从"归档"跳进普通列表，点进去读的就是已删除的日志（`session not found`）。所以这两种情况下端点只删文件并回 `recordHeld: true`。接着浏览器半会通过客户端 `sessions` 服务重拉一次官方会话列表（`refresh()` → `session.list`，它按新列表过滤旧基线，所以消失的会话会被摘掉），**确认列表刷新过之后**再补发一次请求清掉记录——不需要重载页面，也不需要重启。若那个入口不存在或重拉失败，就停在暂留态：`deferred` 那种由后台复查在 15 秒内补清，`absent` 那种留一条看不见的死 id，比屏上一行点开就报错便宜。
- **`absent` 那种情况不会通知其它标签页。** 没有实例可分离 ⇒ 没有事件可广播 ⇒ 其它页面上那一行要等它们自己重拉列表才消失。
- **删历史格式的会话就是更慢，而且不是本插件在读盘。** `sessionPersistence.stat()` 要算修订号，对非当前格式的日志会顺带给整个会话根目录做指纹（每个会话文件一次 `stat()`）。作者机器实测：215 枚会话目录里 66 枚是 `session.v3.jsonl.zstd`、24 枚是 `session.v4.jsonl.zstd`——删这 90 枚中的任何一枚，都要付一次约 215 个文件的遍历；当前格式的会话完全跳过这步。
- **会留下什么。** 本插件删的是会话日志目录。`storages/session_projcache/sessions/` 里的投影缓存条目、`attachments/` 里内容寻址的上传件都归 dsh 自己管，这里不动。本机实测：会话目录消失之后，盘上唯一还带着该 id 的文件就是那枚投影缓存。
- **驱逐用的是运行时内部。** 会话存储没有公开的关闭/驱逐 API，所以第 3 步要探 `store.store` / `entry.detach`，探不到就报 `unsupported` 而不是崩。
- **置顶会话。** dsh 让置顶与归档互斥，所以能走到这一行的会话不可能带置顶。
- **样式是复刻，不是引用。** 这一行逐条对齐官方 `MenuItemButton` 的 DOM 与设计令牌（`div.itemWrap > button[role=menuitem].item.danger` + `.itemIcon` + `.itemLabel`），因为 `dsh-client-ui-primitives` 是构建期依赖、不在 client 模块表里，插件 `require` 不到。官方改菜单外观时，这一行要跟着改。
- **席位契约。** `sidebar.workspaces.session.menu.item` 给子项的是 `{ sessionId, displayTitle }`，外加框架注入的 standard prop `useWorkspaces`（归档集就从它的快照里读）和 `useMenuOpenState`。官方四行在 100/200/300/400。

## 想要更多，商城里有更全的归档管理器

`@michengai/dsh-archive-manager`（设置页一整页：标题与正文搜索、收藏、批量恢复、批量清理、日志诊断修复）、
`dsh-better-archive`（设置区一节 + 右侧栏归档 tab，直接用官方 `Menu` / `RiskConfirmation`）、
`dsh-archive-manager`（侧栏底部面板 + agent 拆卸）。它们都覆盖本插件做的事，而且做得更多。
只在你想要的正是"删除这一格就该长在菜单里、不要再多一页"时，才选这枚。

## 开发

```bash
node test/delete-endpoint.mjs     # 宿主端返回值形状、幽灵记录、负对照（会真删临时目录）
node test/style-injection.mjs     # 浏览器半样式注入契约，四场景
npm test                          # 两枚一起
```

## 许可

MIT，见 [LICENSE](LICENSE)。
