# dsh-multi-chat（多会话并排网格）

**给 DeepSeek Harness Web GUI 的并排会话视图，等分网格。** 在左侧侧边栏每点一个会话，右边的对话区就多出一格：点一下一个，点三个三个；**一行最多 3 个**，窗口变窄自动降为 2 列 / 1 列。被点击（即当前）的会话保持高亮，每个格子里都有自己的贴底输入框，并且可以**拖动面板标题栏右上角的 ⠿ 把手**来调整位置。

English: [README.md](README.md) · 设计依据：[docs/design.md](docs/design.md)

---

## 功能

| | |
|---|---|
| **跟随侧边栏** | 侧边栏每点开一个会话，网格里就多一格；顺序刷新后仍会恢复。 |
| **等分网格** | 一行最多 3 格（3×3 = 最多 9 格，默认 6 格）。行高按可用高度均分，但不会低于可用高度（约 420px），再多了整个网格纵向滚动。窗口窄时 3 → 2 → 1 列自动降级。 |
| **高亮当前** | 当前会话所在格子有描边、标题强调、序号徽标反色。 |
| **点击聚焦** | 点击非当前格子内部，会请求 shell 把该会话切为当前会话（官方侧边栏高亮随动）。 |
| **拖动换位** | 抓标题栏**右上角 ⠿ 把手**（按下即拖）或直接按标题栏（移动超过 4px，触屏长按 300ms）。松手落在另一个格子上=**两格交换**；落在网格空白=**移到队尾**；`Esc` 取消。拖动时有半透明 ghost 跟随光标，目标格子高亮。 |
| **键盘换位** | 把手可聚焦：`Ctrl/⌘ + 方向键` 与相邻格子交换（上下按实际列数计算），其它按键不拦截。 |
| **关闭** | 每格有关闭按钮；当前格子只有在能把 shell 交给另一个格子时才可关闭，否则禁用并给出原因。工具栏「只保留当前」可一键收敛。 |
| **侧边栏开关** | 每个会话行的操作区（archive/pin 旁）新增按钮，可把该会话加入/移出网格，**不改变当前会话**。 |
| **只降级不崩** | 只有 1 格时完全走官方单会话界面；会话不可用时显示提示卡片；单格崩溃只坏该格；缺少 `slots`/`sessions` 时安静失效，绝不拖垮网页启动。 |

## 安装

本包是 DSH bundle 插件：host 半（`.` → `lib/index.js`）只是让包进入 loader roster，
功能在 browser 半（`./client` → `lib/client.js`），由 web shell 依据 `dsh.client` 声明加载。

```powershell
dsh plugin --profile desktop add link:<本包绝对路径>
# 然后重启桌面端 / 该 profile（bundle 层在启动时生效）
```

安装前可只读校验（不写入任何东西）：

```powershell
dsh --profile desktop --dump-config | Select-String dsh-multi-chat
```

卸载：`dsh plugin --profile desktop remove dsh-multi-chat`。

## 开发

```powershell
npm install    # 仅开发依赖：react、react-dom、jsdom、yaml、@deepseek-ai/dsh-client-ui-slots
npm test       # 7 个套件、90 个测试
npm run typecheck
```

**v0.2.2 修复**（来自真机反馈，已在真实浏览器里定位）：上一版把网格注册在**会话作用域**的槽位上，
而 renderer 在 shell 切到另一个 session 时会把这类 entry **整棵重挂载**——于是每次切换会话都会重建整个
网格和所有面板里的对话（这就是「对话多了就卡」，格数越多越明显），并且把刚被点击的输入框一起换掉
（这就是「点输入框要先点一下卡片、再点一下才聚焦」）。现在网格挂在 **root scope 的 `main` /
`conversation` 面板 cell** 上（替换语义相同，但切会话不再重挂载），面板激活也从 `pointerdown` 改到
`focusin`/`click`。真机实测：一次点击即可聚焦输入框；切换会话约一帧；5 格共约 2.6k DOM 节点，离屏
面板走虚拟化。详见 [docs/design.md](docs/design.md) §4.9。

**v0.2.1 修复**：切换会话不再走 `retain → 同步发布 → 再 retain` 的递归（它会爆栈，导致每次切换都很慢，
还让面板描边与官方侧边栏高亮不一致）；指针在网格外松开时不再残留 ghost 卡片或落点高亮环；选中态改为
**单层清晰外环**（原来是边框+内阴影画出的双层发虚边）。根因、复现证据与修法见
[docs/design.md](docs/design.md) §4.8。

| 套件 | 覆盖 |
|---|---|
| `tests/manifest.test.mjs` | 包/bundle/client 半/patch/locale 契约，以及「输入框修复不回退」（embedded 变体、无 cqw/宽度 hack） |
| `tests/host.test.mjs` | host 半惰性且永不抛错 |
| `tests/store.test.mjs` | 面板账本：跟随追加、上限 6/9、淘汰、高亮、`swap`/`moveToEnd`、持久化与 v1→v2 迁移、不可信载荷、落点判定、键盘步进 |
| `tests/registration.test.mjs` | 激活契约：1 格不注册、2 格起遮蔽注册、保活/释放、侧边栏按钮、未知会话、卸载清理、服务缺失 |
| `tests/real-slot-core.test.mjs` | 用官方 `@deepseek-ai/dsh-client-ui-slots` 的**真实 SlotCore** 驱动同一套接线 |
| `tests/render.test.mjs` | 结构渲染：等分网格、唯一高亮、每格把手+关闭、会话体 `variant:'embedded'`、hero/settling 阶段、仅用主题 token |
| `tests/interaction.test.mjs` | jsdom + React DOM 真实交互：拖动交换、落空白移末尾、Esc 取消、标题栏 4px 阈值、`Ctrl+方向键` 换位、关闭/聚焦、侧边栏开关、工具栏、单格崩溃隔离 |

端到端安装验证（可选，需要一个在跑的 profile）：

```powershell
# 隔离 profile，不碰你的桌面 profile
$env:DSH_HOME="$PWD\..\.dsh-verify"
dsh --profile multichat-verify --from-default-profile web --dump-config
dsh plugin --profile multichat-verify add link:$PWD
dsh --profile multichat-verify --port 4399 --no-open
# 另开一个 shell：
npm run e2e:served   -- 4399 <启动时打印的 token>   # 校验 boot graph 与真实下发的 bundle
npm run e2e:browser  -- --port 4399 --token <token>   # 真实拖动 + 截图
```

`e2e:browser` 需要能正常启动 Chrome/Edge；某些沙箱会拒绝 Chrome 的 crashpad 子进程，脚本会明确报出这一点而不是卡住。

`lib/client.js` 就是发布用的浏览器 bundle：单文件、官方 module-loader 包装
（`window.__ModuleLoader__.load({ id, factory })`），唯一外部依赖是 `require('react')`。
没有构建步骤——改完文件，`pnpm run dev:web` 在跑时 client HMR 会直接生效。

## 实现要点（简版）

1. 观察 `ctx.sessions.list`，取 `retainedBy.mainView > 0` 的会话作为当前会话；每个新当前会话进入有序面板集合，这个顺序**就是**网格顺序。
2. 每格自己持有 `sessions.retain(id, { source: 'multichat' })`，用户切走后该会话的 scope 依然存活。
3. 格子数 ≥ 2 时注册到官方文档化的 `main.conversation` **替换点**（`single` + 更低 `priority`），每格渲染 `<SessionProvider session={reference}>` 包住官方 `conversation.content` Factory——并且用 **`variant: 'embedded'`** 渲染，这是在没有官方会话根节点时仍能保住输入框 `position: sticky; bottom: 0` 的关键（根因与证据见 [docs/design.md](docs/design.md) §4.2）。只剩 1 格时注销注册，官方单会话界面原样回归。
4. 样式只注入一个带标记的 `<style>`，颜色/边框只用 `--dsw-alias-*`、`--dsw-radius-*` 主题 token。

## 已知限制

- 官方会话头部（标题面包屑、视图页签、头部动作）属于被替换 entry 自己声明的位置，第三方无法渲染，因此网格模式使用自绘的紧凑面板头。
- 每格都会保活一条会话流，格子越多 host 侧负载越高（默认 6 格、上限 9 格）。
- 拖动为指针操作（鼠标/触屏/触控笔）+ 键盘快捷键；拖到网格边缘暂无自动滚动。
- client boot 路径不向浏览器插件传 cordis 配置，所有可调参数都在网格工具栏 / `localStorage`。

## 许可

MIT，见 [LICENSE](LICENSE)。
