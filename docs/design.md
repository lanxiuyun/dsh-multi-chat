# dsh-multi-chat 设计说明（v0.2.0：等分网格 + 拖拽换位 + 输入框修复）

> 英文版：[design.en.md](design.en.md)。本文是实现依据，代码与测试都以本文的验收标准为准。

## 1. 原始需求与迭代

**第一轮**：开发一个 DSH 插件，让对话区能显示多个 session——左边侧边栏点一下，右边就出现一个 session；点两个出现两个，点三个出现三个；被点击的这个 session 高亮。

**第二轮（本版）**：
1. 布局改为「类似 grid 的等分表格」，**一行最多 3 个**；
2. 可以**拖动**调整每个对话面板的位置（把手在面板**右上角**，只做移动、不做缩放）；
3. 修复缺陷：**两个面板时，底部的输入框位置消失**。

## 2. 需求边界

### 2.1 范围内

| # | 行为 | 说明 |
|---|------|------|
| R1 | 侧边栏点击会话 → 网格出现该格 | 跟随 shell 当前会话（`retainedBy.mainView`），点 n 个得 n 格 |
| R2 | 等分网格，一行最多 3 格 | `3×3` 上限；行高按可用高度均分，不低于约 420px，超出则网格纵向滚动 |
| R3 | 窗口变窄自动降级 | 3 → 2 → 1 列（容器查询，按中心列实际宽度） |
| R4 | 被点击（当前）会话高亮 | 描边 + 标题强调 + 序号徽标反色 + `data-active` |
| R5 | **拖动换位** | 右上角 ⠿ 把手按下即拖；标题栏也可拖（鼠标 4px 位移阈值 / 触屏长按 300ms）；落点在别格=交换，落空白=移队尾；`Esc` 取消；ghost 跟手 + 目标格高亮 |
| R6 | **键盘换位** | 把手可聚焦，`Ctrl/⌘+方向键` 与相邻格交换（上下按实际列数），边缘不越界 |
| R7 | 关闭与收敛 | 每格关闭按钮（当前格需先交接，否则禁用并说明）；工具栏「只保留当前」 |
| R8 | 侧边栏显式开关 | 每行新增按钮，把会话加入/移出网格且不改当前会话 |
| R9 | **每个格子的输入框贴底可见** | 各格独立可用、可发送；不会随消息滚走、空会话也不会贴顶 |
| R10 | 持久化与迁移 | 面板顺序 + 上限写 `localStorage`；v1（含废弃 `layout`）→ v2 平滑迁移 |
| R11 | 错误处理 | `slots`/`sessions` 缺失安静降级；未知会话丢弃并提示、绝不复活；单格崩溃只坏一格；`apply` 全程 try/catch |
| R12 | 测试 | 单测/契约测试/真实 DOM 交互测试，`npm test` 全绿 |

### 2.2 范围外

| # | 不做 | 原因 |
|---|------|------|
| N1 | 不改 DSH 源码、不 fork | 只用官方文档化扩展点 |
| N2 | 不新建第二个 React 应用、不用 iframe、不挂 `document.body` | 官方红线：UI 插件只渲染 slot 组件 |
| N3 | 不重写对话渲染 | 复用官方 `conversation.content` Factory |
| N4 | 不渲染官方会话头部 | `conversation.header` 由被替换 entry 声明，第三方既不能重复声明也不能 `renderSlot`；改为自绘紧凑面板头（唯一有意的功能收缩） |
| N5 | 面板缩放 / 自由像素定位 | 等分网格模型下自由尺寸会破坏等分语义；用户已确认「只移动」 |
| N6 | host 侧配置项 | client boot 只做 `loader.create({name: id})`，不下发 cordis 配置；可调参数一律在浏览器侧 |
| N7 | 跨设备同步 | 面板顺序是浏览器本地视图状态 |

## 3. 验收标准（可执行）

| # | 标准 | 验证方式 |
|---|------|----------|
| A1 | 点第 1/2/3 个会话 → 1/2/3 格 | `tests/registration.test.mjs` + `tests/render.test.mjs` |
| A2 | 只有当前会话那格带 `data-active` | `tests/render.test.mjs` |
| A3 | 非当前格可关；当前格无法交接时禁用 | `tests/interaction.test.mjs` + `tests/store.test.mjs` |
| A4 | 侧边栏按钮切换是否入网且不改变当前会话 | `tests/interaction.test.mjs` |
| A5 | 超过上限：显式加入被拒并提示；跟随当前会话时替换最早一格 | `tests/store.test.mjs` |
| A6 | 未知会话 id 不抛错、不复活，只降级提示 | `tests/registration.test.mjs` |
| A7 | 单格渲染异常只坏一格 | `tests/render.test.mjs` + `tests/interaction.test.mjs` |
| A8 | 缺 `slots`/`sessions` 不注册也不抛错 | `tests/registration.test.mjs` |
| A9 | 包契约（静态 `dsh.client.inject`、`platform: web`、`exports ./client`、patch 行、双语 locale） | `tests/manifest.test.mjs` |
| A10 | 网格一行最多 3 列、行高下限与滚动、窄宽度降级规则存在于样式表 | `tests/render.test.mjs` |
| A11 | **拖动交换**：把手按下即拖 → ghost 出现 → 目标格高亮 → 松手两格交换 | `tests/interaction.test.mjs` |
| A12 | **落空白=移队尾**；`Esc` 取消不改顺序；标题栏 4px 阈值内不算拖动（算点击聚焦） | `tests/interaction.test.mjs` |
| A13 | **键盘换位**：`Ctrl/⌘+←/→` 交换；无修饰键不拦截；越界 no-op | `tests/interaction.test.mjs` + `tests/store.test.mjs` |
| A14 | **输入框修复不回退**：会话体以 `variant:'embedded'` 渲染；面板体不再使用 `container-type`/`cqw` 宽度 hack | `tests/render.test.mjs` + `tests/manifest.test.mjs` |
| A15 | 槽位语义与官方实现一致 | `tests/real-slot-core.test.mjs`（真实 `SlotCore`） |
| A16 | 包能被官方渠道安装并被浏览器真正加载 | 隔离 profile + `scripts/verify-served-bundle.mjs` |
| A17 | 全部测试通过 | `npm test`（7 套件 / 90 测试） |
| A18 | **`retain` 内同步发布不会递归**：每个会话只 retain 一次，且无任何 list handling / sync / stack 警告 | `tests/registration.test.mjs`（假控制器忠实同步发布）+ 真机控制台复验 |
| A19 | **拖拽不会残留**：指针在面板外松开、按下未位移就松开、按住未松开时二次按下，都不留下 ghost/虚线/目标环，也不产生幽灵拖拽 | `tests/interaction.test.mjs` |
| A20 | 选中态是**单层外环**（无 inset 双层边），落点是虚线冷色环，两者不共用样式 | `tests/render.test.mjs` |
| A21 | **网格挂在 root scope 的 cell 上**：切会话不会重挂载网格/各格对话（这是"卡"与"输入框丢焦点"的根因） | `tests/real-slot-core.test.mjs`（断言 `spec('main').scope === 'root'`）+ `tests/registration.test.mjs`（`key='conversation'`） |
| A22 | **第一下点击输入框就聚焦**：pointerdown 不再触发导航；focusin/click 才激活面板 | `tests/interaction.test.mjs` |
| A23 | 面板数超过一行（>3）时开启 `content-visibility` 虚拟化，离屏面板不参与渲染 | `tests/render.test.mjs`（`data-virtualize` 与样式）+ 真机节点数复验 |
| A24 | **窄窗口（如 DSH 浮窗 ~490px）工具栏保持一行并按宽度降级**：永不换行，`≤640px` 隐藏拖动提示、`≤480px` 隐藏用量与全称改用紧凑标签；行高随窗口高度取 `min(420px,62vh)` | `tests/render.test.mjs`（样式与紧凑标签）+ 真机 490×640 复验 |
| A25 | **窄窗口（<720px）不接管**：不注册槽位、不 retain 会话、不写共享存储；窗口变宽后自动恢复（含重新跟随当前会话），再变窄则交还对话区 | `tests/registration.test.mjs`（假 window + resize）+ 真机 490×640 / 1680×1050 / 520×700 复验 |

## 4. 实现要点

### 4.1 扩展点（全部官方文档化）

| 用途 | 扩展点 | 契约 |
|------|--------|------|
| 对话区替换点 | `main` 的 keyed cell（`key='conversation'`） | `keyed` + **`root` scope**，由 ui-layout 的 `root` 声明；ui-conversation 用同一个 key 占位（priority 0）。以 `priority: -1000` 遮蔽该 cell，卸载即恢复。**必须用 root scope**：`session-maybe` 的 entry 在 shell 切到另一个 session 时会被 renderer 整棵重挂载（根因见 §4.9） |
| 每格会话绑定 | `SessionProvider`（标准 props） | `children` 里声明非 `root` scope 子 slot 才会拿到；`<SessionProvider session={reference}>` 可绑定另一个 Session——官方文档所述「并存子树指向不同 Session」 |
| 每格对话体 | Factory `conversation.content` | 任何 entry kit 都带 `renderFactorySlot`；`views`/`widthControls` 局部 slot 有官方 fallback，可不传 |
| 侧边栏行操作 | `sidebar.workspaces.session.row.action` | `list` + `root`，owner props `{sessionId, displayTitle}`；新 `id` 即增量 |
| 会话导航 | `ctx.uiWorkspace.openSession(id)` | soft-get；缺失时只本地高亮 |

### 4.2 输入框消失的根因与修复（A14）

**根因（高置信，已在官方 bundle 中逐条核实）**：官方输入框贴底依赖**阶段门控**规则
（`dsh-client-ui-conversation/lib/client.js:15721`）：

```css
.uPhUma_root[data-phase=active] .uPhUma_composerSeat,
.uPhUma_embeddedBody[data-content-phase=active] .uPhUma_composerSeat{
  z-index:7; background:linear-gradient(...); position:sticky; bottom:0
}
```

同处还有配套的 `.uPhUma_viewArea{flex:1 0 auto;min-height:auto}`、hero 居中、settling 隐藏。
而渲染 `div.uPhUma_root[data-phase=…]` 的正是官方 `ConversationRoot`——**本插件替换的就是它**
（`ui-conversation:15941-15948`）。于是选择器两半同时失效：输入框回到普通文档流，消息区一滚它就被推到视口上方数千像素外；空会话时 `viewArea` 为 null，输入框被默认 `flex-start` 顶到面板**顶部**。

**修复（一个词）**：Factory 以 `variant:'embedded'` 渲染。`ui-conversation:16254` 只在
`variant === 'embedded'` 时加 `uPhUma_embeddedBody` 类，而 `16258` 无条件输出
`data-content-phase`——于是四组规则的 embedded 分支全部复活（贴底、viewArea 尺寸、hero 居中、
settling 隐藏），并顺带得到官方内容宽度变量
`--dsh-chat-content-width:min(calc(100% - 32px),920px)`。官方自己的子代理面板就是这么嵌的
（`dsh-client-ui-subagent:782-786` + 宿主盒子 `:677` = `{width:100%;min-width:0;height:100%;min-height:0;display:flex}`），
本插件的 `.dsh-mc-pane-body` 与该宿主契约一致。**上一版为绕宽度写的
`container-type:inline-size` + `--dsh-chat-user-width:min(100cqw - 28px,920px)` 已删除**。

**排除过的假设**（见 §5 第 5 条）：`@container` 规则不会在窄格子里隐藏输入框（全库仅 2 条，
主体都挂着更近的容器）；`container-type`/`contain:layout` 不会破坏 sticky（不影响滚动容器归属）；
`--dsh-composer-height`/`--dsh-conversation-viewport-height` 由每格的 ResizeObserver 写在各自
scrollBody 上且有 fallback，不会被清零。

> 生产环境注意：`SessionProvider` **不渲染任何 DOM**（仅 React context + Fragment）。测试里的
> 假实现早期画过一个 `div[data-provider]`，那会破坏高度链——现已改成与生产同构，避免测试掩盖问题。

### 4.3 网格布局

- 3 列等分：`grid-template-columns:repeat(3,minmax(0,1fr))`；容器查询按可用宽度降级
  `@container (width<=1100px)` → 2 列、`(width<=720px)` → 1 列（容器是 `.dsh-mc-root` 的 `container-type:inline-size`）。
- 行高：`grid-auto-rows:minmax(420px,1fr)` —— 一行时铺满，两行时均分，低于 420px 就溢出并由
  `overflow-y:auto` 滚动。
- 顺序即数据：store 的 `panes` 数组同时是网格顺序，交换/移尾只改数组顺序，React `key=sessionId`
  保证 DOM 移动而非重挂载（对话组件状态不丢）。

### 4.4 拖拽换位（R5/R6）

- **把手**：面板标题栏右上角（关闭按钮左侧）常驻 ⠿ 按钮，半透明、hover 变亮、`:focus-visible` 有描边。
- **按下即拖**（把手）/ **标题栏**：鼠标按 4px 位移阈值判定；触屏/触控笔长按 300ms 后进入拖动。
- **指针捕获**：在面板元素上 `setPointerCapture`，move/up 都回到该面板；`Esc`（全局 keydown，捕获阶段）取消。
- **落点判定**：`document.elementFromPoint` 命中 `[data-mc-session]`；不可用时退回各格 `getBoundingClientRect` 命中测试（jsdom/无布局环境）。命中自身忽略，命中别格=交换，命中空白=移队尾。
- **反馈**：拖动中的格子 `data-dragging`（虚线+半透明），目标格 `data-drop-target`（描边），ghost 卡片用 ref 直接改 `transform`（**不**触发每帧 React 重渲染），`MultiChatPane` 用 `React.memo` 隔离拖动重渲染，官方对话子树不参与协调。
- **键盘**：把手聚焦后 `Ctrl/⌘+←/→` ±1、`↑/↓` ±列数（列数从计算样式读取，取不到则按 3 列），越界 no-op，不拦截其它按键。

### 4.5 会话保活与跟随

每格 `sessions.retain(id, { source: 'multichat' })`，关闭即释放；官方 `publishMain` 只看
`retainedBy.mainView`，自定义 source 不会抢走「当前会话」。catalog baseline 未就绪
（`list.phase !== 'ready'`）时暂不 retain，避免把持久化里的合法面板误判为未知会话；`retain`
对未知会话抛错，捕获后丢弃该格并提示，绝不复活/新建会话。关闭当前格会先
`openSession(next)` 再用 `suppressedId` 抑制跟随把它加回来；无法导航时直接拒绝关闭。

### 4.6 持久化与迁移（R10）

键仍为 `dsh-multi-chat:v1`，写 `{version: 2, panes, maxPanes}`。读取时校验为不可信输入：
只保留非空字符串 id、去重、按上限截断；v1 的 `layout` 字段直接忽略（该模式已废弃）。
上限默认 6、硬上限 9（`normalizeMaxPanes`）。

### 4.7 错误处理与样式

`apply` 全 try/catch（浏览器半抛错会拖垮 web boot）；单格 `PaneBoundary` 隔离；
entry 级异常由官方 `SlotErrorBoundary` 兜住并让官方视图复位。样式单标签注入、类名前缀
`dsh-mc-`、颜色/边框只用 `--dsw-alias-*`/`--dsw-radius-*` token。

### 4.8 v0.2.1 修复（真机复现后定位）

**F1（严重）会话切换慢 + 高亮错位：`retain` 同步发布导致的相互递归爆栈。**
真机（无头 Chrome 打开隔离 profile）复现到的原始报错：

```
[dsh-multi-chat] session list handling failed: RangeError: Maximum call stack size exceeded  at syncReferences
[client-store] subscriber failed: RangeError: Maximum call stack size exceeded  at UiSession.watchMainRetention
Sidebar Session opening failed: RangeError: Maximum call stack size exceeded
```

机制：`sessions.retain(id)` **同步**发布会话列表情动（`publishRetention → list.set`），而
`syncReferences()` 原本是在 `retain()` **返回后**才把引用写进 Map —— 于是嵌套的列表回调看到
"这个 id 还没被 retained"，再次 `retain` → 再发布 → 无限递归，直到爆栈。每一次会话切换都触发这
条路径，所以表现为「切换很慢」；异常打断了 UiSession 的 main binding 投影，所以（面板描边与官方
侧边栏）高亮状态会错位/闪动，看起来就是「蓝色高亮边框显示得不对劲」。

修法两层：
1. `pendingRetains` 标记：调用 `retain` **之前**登记该 id，递归进入时直接跳过（同一 id 只 retain 一次）；
2. `syncNow()` 重入闸门：`syncing` 期间只置 `resyncRequested`，由当前调用做有界多轮（≤4）收尾，
   仍有余量则 `queueMicrotask` 延后到当前栈之外继续，绝不再加深调用栈。

回归测试：`tests/harness.mjs` 的假会话控制器现在**忠实模拟**「retain 内同步发布」这一行为（这正是
旧代码会爆栈的触发点），并新增两条用例断言「每个会话只 retain 一次」且「没有任何 list handling failed /
sync failed / call stack 警告」——旧实现会在这些用例里直接栈溢出。

**F2 拖拽残留（"边框显示得不对劲"的另一来源）：指针在面板外松开。**
原先 move/up 只挂在面板元素上，指针在侧边栏/窗口外松开时收不到 `pointerup`，于是 ghost 卡片、被拖
格子的虚线、目标格的高亮环都会**留在界面上**，而且下一次划过面板还会用陈旧的按下状态启动"幽灵拖拽"。
改为：按下时记录会话，move/up/cancel/blur **统一在 window 上（捕获阶段）**处理；新的按下会先复位旧会话；
按 `pointerId` 校验；拖动目标探测按「60ms 或位移 12px」节流（`elementFromPoint` 会强制布局，避免高频卡顿）。
回归测试：`tests/interaction.test.mjs` 新增「指针在面板外松开」「标题栏按下未位移就松开」「按住未松开时
二次按下」三条用例。

**F3 选中描边渲染：从「边框 + inset 阴影」改为单层外发光环。**
原来 `border:.5px` 加 `box-shadow: inset 0 0 0 1px` 会在非整数像素比下画成双层/发虚的边（这就是
「边框显示得不对劲」的字面来源）。现在当前会话用**单层 2px 外环**
`box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)`；
拖拽落点改成**虚线 + 冷色环**，与选中态在形状和颜色上都不同，不会混淆。

**F4 切换/滚动的额外开销**：面板改为接收 `title`/`blank` **原始值**而不是整行对象（会话列表每次投影
都会新建行对象，会让 `React.memo` 失效并连带重渲染每个官方对话子树）；`onHandleKeyDown` 用 ref 读当前
顺序以保持回调身份稳定；侧边栏行按钮改用两个**原始值选择器**（是否入网、是否当前），不再整快照订阅。

**本轮的验证边界（诚实说明）**：隔离 profile 的浏览器里，宿主侧「新建会话」在无 provider/工作区上下文时
是空操作，因此**无法**在那里凑出 2 个以上会话去端到端跑网格、拖拽与输入框；本轮真机验证到的是
「递归消失、控制台干净、会话能打开、插件正常激活」。网格/拖拽/输入框的端到端验收仍由用户在自己的
desktop profile 里完成（插件已装好，重启即生效）。

### 4.9 v0.2.2 修复（真机截图与数据定位）

**F5（严重）网格注册点错误 → 每次切会话整棵重挂载。**
上一版把网格注册在 `main.conversation`（`session-maybe`）。renderer 对 `session-maybe` entry 的规则是
「换到另一个 session 就重挂载」（"component-local state must not leak between sessions"），于是
**每次切换会话，整个网格连同 N 个对话子树被完整重建**。这同时造成用户报的两个现象：
- 「对话多了就卡」：N 越多，重建的量越大；
- 「点输入框要先点一下卡片、再点一下才聚焦」：按下的那个输入框随即被重建，焦点丢失，第二下才落到新节点。

修法：把注册点挪到 **`main` 的 keyed cell（`key='conversation'`，`root` scope）**——同一个替换语义
（更低 priority 遮蔽官方 conversation 面板 cell），但 **root scope 不随 session 变化重挂载**。
另外把面板激活从 `pointerdown` 改到 **`focusin` / `click`**：先让浏览器完成自己的聚焦，再让 shell 切会话，
双保险杜绝"抢焦点"。真机复验（4 格，无头 Chrome + 已关掉首次使用弹窗）：

```
一次点击非当前格的输入框 → activeElement = DIV.Q7WfXG_input（就是输入框本身）
                          inComposer = true, 该格同时成为当前格
切换会话耗时 ≈ 24ms（含 CDP 往返，实际约 1 帧）
```

**F6 多面板渲染开销**：面板数 > 3（即必然出现第二行）时网格加 `data-virtualize`，对离屏面板启用
`content-visibility:auto` + `contain-intrinsic-size:auto 420px`，离屏对话不参与布局/绘制；持久化只在
「面板顺序或上限」真正变化时落盘（不再为高亮变化触发同步 storage 写入）。真机实测：**5 格总 DOM
节点 2651**（每格约 400–900，含官方完整对话体），控制台干净。

**F7 无头验收脚本的坑（记录以免误判）**：全新 profile 首次打开会有「内测声明 / 添加 API Key」两个
模态弹窗，其遮罩 (`div._mask_…`) 会吃掉 `elementFromPoint` 与合成点击——必须在自动化里先点掉
「继续 / 稍后配置」再测交互，否则会误判为"点击无效"。隔离 profile 的宿主侧在无凭据时无法新建可列出
的会话，因此真机网格验证用的是**给插件自己的 localStorage 面板集合预置真实 session id** 的方式。

**F8 窄窗口（DSH 浮窗/小窗）工具栏被挤成三行（v0.2.3）**：`.dsh-mc-bar` 的每一项都能收缩换行，在
~490px 宽的浮窗里就变成「3 个会话 / 并排」「已用 3/4 / 格」「拖动面板右上角…/ 调整位置」三行，把会话区
压扁。改为：`flex-wrap:nowrap` + `white-space:nowrap`，标题/提示/用量都 `min-width:0` + 省略号；再按容器
宽度逐级降级（`≤640px` 去掉拖动提示，`≤480px` 去掉用量并换用紧凑标签「N 格」，只保留「只保留当前」按钮）；
行高同时改为 `minmax(min(420px,62vh),1fr)`，小窗里 640px 高 → 每行 397px。真机 490×640 复验：工具栏
**1 行 37px**、1 列、输入框可见、控制台干净。

**F9 窄窗口（DSH 浮窗）不再接管并排（v0.2.4）**：浮窗只有约 490px 宽，把 N 个面板竖着堆在一列里，不如官方
单会话视图。现在以窗口宽度做闸门：`window.innerWidth < 720`（与最窄的 CSS 断点一致）时插件**完全惰性**——
不跟随当前会话、不 `retain` 任何会话、不注册槽位，**也不写 localStorage**（浮窗与主窗口共享同一存储，写就会
覆盖主窗口的面板集合）；同时监听 `resize`：变窄 → 释放引用并交还对话区，变宽 → 重新跟随当前会话并挂载网格。
读取宽度时「未知或 0 视为宽」（fail-open），避免在拿不到 `innerWidth` 的环境里误关功能。
真机复验：**490×640 冷启动 = 0 网格 / 0 工具栏 / 1 个官方会话体且输入框正常**；拉到 1680×1050 = 4 格 4 输入框；
再收窄到 520×700 = 又回到官方单会话；控制台全程干净。

## 5. 已知限制与风险

1. **官方会话头部被替换**（标题面包屑/视图页签/头部动作）——单槽替换的固有代价。
2. **每格保活一条会话流**，格数越多 host 负载越高；默认 6、上限 9。
3. **依赖官方内部 Factory `conversation.content`** 与其 `embedded` 变体语义；若上游移除，插件降级为提示卡片（不崩溃），需跟进。
4. **拖动无边缘自动滚动**：格子很多时需要先滚动到目标行再拖。
5. **真实浏览器视觉终检未在本会话沙箱内完成**：Chrome/Edge 的 crashpad 子进程被沙箱拒绝（`OpenProcess: 拒绝访问` → self-terminating），`scripts/browser-e2e.mjs`（真实拖动断言 + 截图）作为可在普通机器运行的验收工具交付。本会话内完成的是：jsdom 真实 DOM 交互测试（含拖动/键盘/取消）、真实 `SlotCore` 契约测试、隔离 profile 的真实安装与下发验证。
