# 22 — Felt Quality：对话、切换、色彩与动效全量方案

**状态**: 设计已定，待实施。  
**范围**: 只改「手感」。不新增功能面，不重做信息架构，不碰 sidecar RPC 契约（除非现有命令已足够支撑）。  
**前提**: 0.7.3–0.7.5 已经把功能搬对了地方（dock、chat/agent 分栏、全宽转录、上下文 popover）。下一阶段的胜负是绘制路径和视觉语言，不是再加面板。

---

## 0. 北极星

打开应用后，用户应该感觉到四件事同时成立：

1. **字是长出来的，不是弹出来的。** 流式时列表不拽、定稿不换皮。
2. **点会话就像翻页，不是重载。** 旧画面一直待到新画面就绪，中间没有空白。
3. **一屏只有一种强调色。** 浅色纸 + 青绿，深色是它的夜版，不是另一套钴蓝产品。
4. **控件在响应，布局在静止。** hover / press 只改颜色和透明度，不改宽度、不缩放列表行。

一句话：从「功能正确的控制台」变成「安静的桌面工具」。

---

## 1. 明确不做

| 不做 | 原因 |
|---|---|
| 重做三栏布局 / 再搬 dock | 0.7.3 的结构已经对 |
| 新功能（hooks 深度、PTY、Voice/Collab 重做） | 另立项；半成品入口本方案只规定「不要更吵」 |
| 换虚拟列表库 | TanStack Virtual 的问题在用法，不在库 |
| 逐 token 真·60fps Markdown 全量重解析 | 做不到也不需要；要的是观感连续 |
| 像素级复刻 TUI 黄 | 浅色纸 + 青绿已经是 GUI 正身 |
| Windows / Linux / 签名 | 平台问题，不在手感范围内 |
| 为动画而动画（页面转场、列表 stagger） | 会更像网站，不是桌面 |

---

## 2. 五条硬合同

后面所有 PR 都对照这五条验收。违反任何一条就是回归。

### 2.1 色彩：一个强调色家族

浅色是正身，深色必须是同一套色相的夜间版。

**锁定的浅色主色**

- 强调：`#0f766e`（现状保留）
- 主按钮保持近黑——它是「执行」，不是第二强调色。不要再给它青绿填充。
- thinking 六档改成青绿明度阶，删掉棕 `#9d4e15` / `#b45309`。
- `--omp-syntax-keyword`、`--omp-status-model`、`--omp-custom-msg-label` 退出紫色。keyword 走强调色深浅；model / custom label 走 `--omp-text-secondary` 或青绿。
- 语法高亮只允许：青绿（keyword / function）、棕（string，仅代码内）、灰（comment / punct）、墨（variable）。一屏里不再出现独立的紫。

**面要能分清**

| 角色 | 浅色目标 | 相对现状 |
|---|---|---|
| 画布 | `#f7f5f2` | 从纯白退下，让卡片和代码浮出来 |
| 侧栏 / 面板 | `#f3f1ed` | 比画布略深一档 |
| 用户气泡 | `#efebe4` + 可见发丝边 | 现在和画布差 2%，几乎没边 |
| 代码块 | `#eeece8` | 现在 `#f6f5f3` 糊进页面 |
| 内容卡 | 仍无填充，只用 `--omp-border` | 发丝线从 `#e5e2dc` 提到 `#d8d4cc` |

**深色**

- `--omp-accent` 从 `#5b8cff` 改为青绿亮色（建议 `#2dd4bf` 的降饱和版，约 `#4db6ac`），bright / dim / glow 跟着走。
- 画布保持石墨，不要抄浅色的暖纸。
- thinking / syntax / status-model 与浅色同一色相逻辑。
- 用户气泡不要再用钴蓝底 `#1d2d49`。

**Agent TUI 覆写收口**

`initAgentThemeSync` 现在把 TUI 主题写进几乎全部 GUI token，包括 chrome。这是第三套品牌的入口。

合同：覆写白名单只覆盖 **转录内部**——markdown、syntax、diff、thinking、tool rail、user/custom message。禁止覆写 `--omp-accent`、sidebar / titlebar / modal / btn / input / status-line chrome。TUI 主题可以改变「读代码的感觉」，不能改变「这是不是同一个 app」。

六个浅色命名主题（Porcelain / Linen / …）继续存在，但必须通过同一套角色映射生成，不能各自发明 keyword 紫。

### 2.2 动效：两档时长，禁止布局动画

**尺**

```css
--omp-motion-fast: 120ms;   /* hover 着色、press 透明度、caret */
--omp-motion-med:  180ms;   /* overlay 出现/消失、toast */
--omp-ease: cubic-bezier(0.22, 1, 0.36, 1);
```

删除 140 / 150 / 160 / 170 / 200 / 220ms 这些散落值。`scripts/lint-surfaces.mjs` 增加一条：renderer CSS 里除上述两个时长外，禁止裸 `transition` / `animation-duration`（`prefers-reduced-motion` 的 `animation: none` 除外）。

**允许**

- 颜色、透明度、阴影
- overlay 的 opacity + 4px 内 translate（只用于 modal / toast / popover）
- 一个活着的循环：流式光标闪烁，或思考块一个极弱的 opacity 呼吸。两者不同时出现在同一视口焦点上——思考展开时停光标闪，思考收起时停呼吸。

**禁止**

- 任何交互行的 `width` / `height` / `grid-template-rows` / `margin` transition
- 列表行、侧栏行、工具行上的 `transform: scale(...)`
- 侧栏标题跑马灯
- 思考块扫光（`omp-thinking-sweep`）
- Tailwind `animate-ping` 用在会话/工具状态点上（保留给真正的「需要你看」：审批、失败）
- 虚拟行进出的 fade（虚拟列表 fade 会造成残影，比硬切更差）

**侧栏 hover 新合同**

操作按钮绝对定位叠在行右侧，底层垫一条与侧栏同色的 8px fade，标题宽度在 hover 前后不变。`visibility` / `opacity` 120ms，零 width 动画。

### 2.3 流式对话：订阅面拆开，定稿不换树

**渲染职责**

| 组件 | 允许订阅 | 禁止订阅 |
|---|---|---|
| `ChatStream` | `messages` 引用、`streamingMessage` 是否存在、`isStreaming`、sessionId | `streamingText`、`streamingThinking`、二者的 `.length` |
| `StreamingText` | `streamingText` | — |
| `ThinkingBlock[live]` | `streamingThinking` | — |
| 虚拟器 pin 效果 | `rows.length`、`sessionId`、`pinned` | 流式长度、`historyRows` 对象身份 |

`followOnAppend` + `anchorTo: "end"` 只在 **行数增加** 时吸底。行内长高靠浏览器布局，不再每 token `scrollToEnd()`。

**估高**

按 `rowKey` 缓存上次 `measureElement` 高度。没有缓存才用 kind 默认值。默认值改为更接近现实：user 72、assistant 160、process 48、streaming 80。缓存随 `sessionId` 清空。

**定稿**

`message_end` 时不要卸 `StreamingRows` 再挂 `MessageBubble`。目标路径：

1. 流式行的 React key 在定稿后保持不变（用即将到来的 message identity，或一个 turn-local `stream:<responseId>`，finalize 时仍用它）。
2. 同一棵 `MarkdownRenderer` 从 `throttledText` 切到最终 `content`，组件不 unmount。
3. 光标用 CSS 隐掉，不是卸载。

做不到完全同 key 时的最低标准：finalize 当帧内旧树和新树并存零帧——用 `startTransition` 或在 store 里先写入最终 message、再清 streaming，让 React 在同一次 commit 里完成替换，并给虚拟器一个「这一帧不要 re-anchor」的标记。

**Markdown 成本**

流式阶段：只把 **最后一个未闭合段落** 当 Markdown 解析，已稳定的前缀（以 `\n\n` 结束）缓存为已渲染树。定稿后再做一次完整 parse（含 highlight / KaTeX）。思考块在 **折叠时不 parse**，只更新字数/速率。

`STREAM_FORMAT_FLUSH_MS` 从 120 提到 200。段落边界仍立即 flush。

### 2.4 切换：先有下一帧，再丢当前帧

统一成一条协议，侧栏切 session、Tab 切、`⌘P` 共用。

```
click
  → 目标行进入 pending（不擦当前画面）
  → 若有该 session 的内存 bundle：立即 restore，标 stale
  → 并行 hydrate（getState + getTranscript 优先）
  → 核心数据就绪：一次 commit 换画面
  → 附属（subagents / queue / goal / settings）随后补丁，不触发 transcript 重挂
  → pending 结束
失败
  → 回退到点击前的 bundle，toast，不要停在空白
```

**禁止** `resetSessionSurface()` 发生在 hydrate 成功之前。擦除只允许作为「新画面 commit」的同一 tick。

**hydrate 对 Tab 缓存的态度**

`restoreBundle` 已经能画出可用画面。随后的 `hydrateSession` 必须 **按 identity 调和**，禁止 `set({ messages: fetched })` 在 fetched 与当前列表 delivery-key 一致时整表替换。

伪代码：

```ts
if (sameIdentitySequence(current, fetched)) {
  // 只补 tail / 修 tool 结果，不换数组身份
  return patchTail(current, fetched);
}
// 序列真的变了（compaction、fork、别的进程改了文件）才整表替换
commitReplacement(fetched);
```

`sameIdentitySequence` 用已有的 `messageIdentityKey`。工具结果内容变了但 key 相同：就地更新那一条，不要重排。

**没有缓存的首次打开**

保留当前画面，在 transcript 上叠一层不抢焦点的顶栏细进度（1px accent，不定进度），不要把对话卸成空状态。`status === "starting"` 的居中 spinner 只用于窗口冷启动，不用于 session 切换。

**busy 会话**

维持现有 `SessionSwitchDialog`（新 Tab / 新窗口 / 中止并切换）。本方案不改这条产品决策。

### 2.5 Chrome：每个事实只出现一次

| 事实 | 唯一位置 | 删除 |
|---|---|---|
| 上下文用量 | composer 发送键旁的圆钮 + popover | 标题栏百分比、页脚进度条 |
| 模型 / thinking / fast / 审批 | composer（Agent tab） | 页脚 model+thinking 段 |
| 工作区路径 + git | 页脚 | — |
| 会话名 | 标题栏（可编辑） | 页脚重复的 session_name |
| 模式（plan / goal / loop / vibe / paused） | 页脚徽章，仅在激活时出现 | composer 里再做一排模式芯片（收进 overflow） |

**Composer 两级**

默认可见：附件、textarea、发送、上下文圆钮。  
Overflow（一个 `⋯` 或「模式」）：thinking、fast、审批、plan/vibe/loop。  
Chat tab 维持现状（已裁掉工具控件）。

`statusLine.preset` 继续被尊重，但 GUI 子集缩到：path、git、激活中的模式徽章。`minimal` = 只留 path。不再假装能画 TUI 的 token/cost/rate 段。

---

## 3. 工作流与文件

五条合同对应五个工作流。可以部分并行，但有依赖。

```
A 动效尺 + 侧栏 hover     ─┐
B 色彩合同（浅+深+覆写）   ─┼─→  C 切换协议  ─→  D 流式管道  ─→  E Chrome 密度
                            │         │
                            └─────────┴─ 视觉回归用同一套 token / motion
```

A、B 互不依赖，先合。C 依赖「不要空白」的交互，不依赖色彩。D 最难、最容易回归，放在 C 稳定之后。E 可以和 D 部分并行，但 composer 改动会碰到 D 的 StreamingRows 几何，建议 D 后再做。

### A — 动效与侧栏

**改**

- `src/renderer/styles/global.css` — 写入 `--omp-motion-*`，删散落时长；`.omp-pressable` 改为 opacity/color，去掉 `scale(0.97)`；删 `.omp-lift` 的 translateY；删跑马灯 `@keyframes omp-sidebar-title-reveal`；侧栏 action 改为 overlay。
- `src/renderer/styles/components.css` — 删 `omp-thinking-sweep`；思考只保留可关的弱呼吸；caret 去掉 `box-shadow` glow。
- `src/renderer/components/layout/Sidebar.tsx` — `SidebarScrollingTitle` 不再测 overflow、不再跑动画；hover 不改 title 宽度。
- `scripts/lint-surfaces.mjs` — 增加 motion 时长白名单。

**测**

- `Sidebar.test.tsx`：hover 前后标题 `clientWidth` 不变（或 DOM 上 action 容器没有 width transition class）。
- 视觉：`prefers-reduced-motion` 下零循环动画（caret 除外可切成静态块）。

### B — 色彩

**改**

- `src/renderer/styles/theme-light.css` — 画布/气泡/代码/边框对比；thinking 阶；去掉紫。
- `src/renderer/styles/theme-dark.css` — accent 改青绿家族；user-msg 去钴蓝；thinking/syntax/status-model 对齐。
- `src/renderer/lib/themes.ts` — `TUI_TOKEN_TO_CSS_VAR` 拆成 `TRANSCRIPT_OVERLAY_VARS`；`applyAgentOverrides` 只写白名单。
- 六个命名浅色主题的生成/覆盖表（`themes.ts` 内 named themes）按同一角色映射重跑。
- `src/renderer/lib/themes.test.ts` — 断言 chrome token 在 overlay 前后不变；dark accent 与 light accent 同色相（hue 差 < 30°）。

**测**

- 现有 `themes.test.ts` 扩展。
- 人工：同一会话浅/深切换，侧栏/标题栏/按钮色相连续；代码块与画布可一眼分开。

### C — 切换协议

**改**

- `src/renderer/hooks/use-session-switch.ts` — `switchSessionNow` / `newSessionNow` / `dropSessionNow` 不再先 `resetSessionSurface`。抽出 `commitSessionSurface(next)`，在 hydrate 核心返回后调用。
- `src/renderer/hooks/use-rpc-events.ts` — `hydrateSession` 拆成 `hydrateCore`（state+transcript）和 `hydrateSecondary`；transcript 走 identity reconcile。
- `src/renderer/stores/messages.ts` — 新增 `reconcileFetched(fetched)`，供 hydrate 调用。
- `src/renderer/stores/tabs.ts` — `switchTab`：restore 后 hydrate 用 reconcile，不整表 set；路由失败走现有回退。
- `src/renderer/stores/session.ts` 或 `ui.ts` — `switchPending: { from, to } | null`，供侧栏/Tab 画 pending。
- `src/renderer/components/layout/Sidebar.tsx` / `TabBar.tsx` — pending 行样式（不 disable 整个侧栏）。
- `src/renderer/components/chat/ChatStream.tsx` — 去掉切换时的空状态闪现：`rows.length === 0 && switchPending` 不渲染 empty canvas。

**测**

- `use-session-switch.test.ts`：hydrate reject 时 messages 仍是旧数组。
- `use-rpc-events.test.tsx`：fetched 与 current identity 相同时，`messages` 数组引用不变或长度变化仅等于 tail。
- `tabs.test.tsx`：switchTab 在 hydrate 返回前已经能读到 restore 的 messages。
- 手测：长会话 A → 长会话 B → 立刻返回 A，中间零空白帧。

### D — 流式管道

**改**

- `src/renderer/components/chat/ChatStream.tsx` — 拆除对 `streamingTextLen` / `streamingThinkingLen` / `historyRows` 的 pin 依赖；估高缓存；streaming 行稳定 key。
- `src/renderer/components/chat/StreamingText.tsx` + `lib/markdown.tsx` — 前缀缓存 + 尾段 parse；暴露 `stablePrefix` 接口或内部 memo。
- `src/renderer/components/chat/ThinkingBlock.tsx` — 折叠时不挂 `MarkdownRenderer`。
- `src/renderer/components/chat/MessageBubble.tsx` — 接收「从 live 晋升」的路径，避免重挂。
- `src/renderer/hooks/use-throttled-text.ts` — 200ms；前缀边界仍立即。
- `src/renderer/stores/messages.ts` — finalize 顺序：先 append 最终 message（带与 stream 行相同的 key 提示），再清 streaming，同一次 `set`。

**测**

- `ChatStream.test.tsx`：流式期间 `scrollToEnd` 不被每个 delta 调用（spy virtualizer 或抽 hook 测）。
- `ThinkingBlock.test.tsx`：collapsed + live 不渲染 `.markdown-body`。
- `markdown.tsx` 相关测试：前缀不变时，旧节点不因尾段增长而重挂（可用 debug 计数或容器 firstChild 身份）。
- 手测：打一段带代码块的长回复，列表不往下拽；定稿时光标消失、正文不闪。

### E — Chrome 密度

**改**

- `src/renderer/components/layout/StatusFooter.tsx` — 去掉 model / thinking / context 段。
- `src/renderer/components/layout/TitleBar.tsx` — 去掉上下文百分比。
- `src/renderer/components/layout/InputArea.tsx` + `ComposerModes.tsx` + `ThinkingControl.tsx` + `ApprovalControl.tsx` — 收到 overflow 菜单。
- `src/renderer/locales/en.ts` + `zh.ts` — overflow 触发器、菜单项的无障碍名。
- `src/renderer/components/layout/mode-visibility.test.tsx` / `InputArea` 测试 — Chat tab 仍无工具；Agent tab 默认看不到 thinking 芯片，打开 overflow 后可见。

**测**

- 现有 footer / composer 测试改断言。
- 手测：上下文只在发送键旁；页脚只剩 path · git · 模式徽章。

---

## 4. PR 切分

每个 PR 必须单独可发布，合进去手感只增不减。

| PR | 标题 | 依赖 | 预估 |
|---|---|---|---|
| 1 | `motion: two-speed scale, no layout hover` | — | 1 天 |
| 2 | `theme: single accent family, constrain TUI overlay` | — | 1–2 天 |
| 3 | `session: commit-on-hydrate, no blank switch` | — | 2 天 |
| 4 | `transcript: split stream subscriptions, stable finalize` | 3（避免切换重测流式） | 2–3 天 |
| 5 | `chrome: one fact, one place` | 2（颜色稳了再收控件） | 1 天 |
| 6 | `qa: light/dark + long-stream + switch matrix` | 1–5 | 0.5 天 |

不要把 3 和 4 塞进同一个 PR。切换回归和流式回归混在一起会测不完。

PR 6 不是功能，是验收清单落地：`design-qa.md` 增补 Felt Quality 一节，附切换前后、流式中、浅/深各一张 Electron 截图。

---

## 5. 验收标准（可证伪）

用秒表和眼睛，不靠感觉词汇。

**切换**

- 点击侧栏另一条已打开过的会话：从 pointerup 到新标题出现 ≤ 50ms（走 bundle），旧转录不得先变成 empty canvas。
- 点击从未在本进程打开的会话：旧转录保持可见直到新转录 commit；允许顶栏 1px 进度。
- hydrate 失败：画面仍是点击前的会话，有 error toast。
- 快速连点三条会话：只 hydrate 最后一条（`hydrationVersion` 已有），中间态不闪空。

**流式**

- 以 ≥ 80 tok/s 打 2k 字含一个代码块：主滚动容器的 `scrollTop` 在 pinned 期间的抖动（相邻两帧差的绝对值中位数）< 2px。
- 定稿那一帧，流式行的 DOM 节点（或 `[data-transcript-kind]`）不发生 unmount/remount。若技术上必须换节点，用户可见的正文几何变化 < 4px。
- 折叠的思考块在 live 期间不出现 `.markdown-body`。

**色彩**

- 浅色一屏内，除 success/error/warning 语义点和代码 string 外，不出现 hue 在 260–320（紫）的大面积色。
- 深色 `--omp-accent` 与浅色 `--omp-accent` 的 hue 差 < 30°。
- 打开任意 TUI 主题覆写：`--omp-sidebar-bg`、`--omp-btn-primary-bg`、`--omp-accent` 与覆写前相同。

**动效**

- 侧栏任意行 hover 前后，标题文字的 layout width 不变。
- `lint-surfaces` 在新增 140–220ms 散落值时失败。
- `prefers-reduced-motion: reduce` 下，思考扫光/呼吸、跑马灯、pulse-dot 均为 none。

**Chrome**

- 同一时刻，上下文百分比只出现在 composer 圆钮/popover 里。
- Agent composer 默认行内控件 ≤ 4 个（附件、发送、上下文、overflow）。

---

## 6. 风险与回退

| 风险 | 为什么会发生 | 回退 |
|---|---|---|
| 定稿同 key 和现有 `buildTranscriptRowKeys` 冲突 | 历史行 key 用 message identity，stream 行现在是 kind | 保底走「同 commit 替换 + 禁一帧 re-anchor」，不要为了同 key 重写整个 row key 体系 |
| identity reconcile 漏掉 shake/重写的 tool 结果 | key 不含内容 | 同 key 时用引用不等则替换该元素，不换整表 |
| 不 `scrollToEnd` 导致 pinned 用户看不到最后一行 | 行内长高时 `followOnAppend` 不管 | 只在 `pinned && distanceFromBottom < 80` 时，用 `ResizeObserver` 对 **最后一行** 微吸，不绑 token |
| 深色改青绿后对比不够 | 石墨底上的低饱和青 | 验收时对照 WCAG AA；不够就提高 bright，不改回钴蓝 |
| TUI 覆写白名单让老用户觉得「主题没了」 | 他们在用 theme.dark 换整窗颜色 | 设置里写一句：TUI 主题只作用于对话内容。不要重新打开 chrome 覆写 |
| Composer overflow 降低审批可见性 | 「完全访问」被藏起来 | overflow 触发器在非默认审批时显示小点；不把审批再搬回页脚 |

---

## 7. Key Decisions

1. **先合同、后组件。** token / motion / switch / stream 四条合同先合进代码（CSS 变量 + lint + hydrate 时序），再改各个表面。否则每个 PR 都会重新发明时长和擦除时机。
2. **Tab 缓存是第一帧的真相，hydrate 是补丁。** 现在是反过来的：restore 画完立刻被整表替换。这是切 Tab「闪两下」的根因。
3. **ChatStream 不准订阅流式文本。** 这是对话发飘的根因。估高缓存和同 key 定稿是增强，拆订阅是必须。
4. **深色跟随浅色色相，不保留钴蓝。** 两套品牌比「深色用户习惯蓝」伤害更大。命名浅色主题继续活，但走同一角色映射。
5. **TUI 主题降级为转录皮肤。** GUI chrome 是产品身份，不能被 sidecar 主题改掉。
6. **hover 不许改布局。** 侧栏跑马灯和 width 展开是「细节难受」的最大单一来源，单独一条合同，避免以后再以 Codex 对标加回来。
7. **每个事实一处。** 上下文 / 模型 / 会话名的重复不是信息丰富，是状态栏时代的残留。页脚退回 git+path。
8. **3 和 4 分 PR。** 切换和流式都碰 messages store，混在一起无法判断是谁打破了空白帧或定稿闪。

---

## 8. 和既有文档的关系

- `plan/03-ui-design.md` 的「Dark by default / 95-color TUI 黄」作废，以本文 2.1 为准。
- `plan/05-performance.md` 的三阶段 batch 目标保留；本文补上它没写的「组件订阅面」和「定稿不换树」。Stage 2 里把整段 `streamingText` 放进 zustand 仍然可以，但读它的组件必须是叶子。
- `plan/15` 之后的功能对等工作不回退。本方案不撤销 dock / navigator / context popover / 全宽转录；E 只是删重复入口。
- `design-qa.md` 现有各节（dock、navigator、popover）在 PR 6 复验，防止手感改动打坏已过的视觉合同。

---

## 9. 实施时怎么开工

不要从「把深色调好看」开始。第一天落地的应是 **PR 1 的 motion 尺 + 侧栏 overlay**，当天就能感到「滑过侧栏不再缩一下」。第二天 **PR 2 色彩**。第三、四天 **PR 3 切换**——这是用户点名的第二痛。流式（PR 4）单独留出完整两天，含长回复手测。最后收 chrome。

全程对照第 5 节的可证伪标准。说「顺了」不算过；说「pinned 时 scrollTop 中位抖动 < 2px」才算过。
