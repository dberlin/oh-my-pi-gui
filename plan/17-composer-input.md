# 17 — Composer 与输入层设计(Workstream B)

**状态**: plan,未实施。源码核实于 2026-08-05。配套 [15-parity-closeout.md](./15-parity-closeout.md)。
**范围**: GUI 侧输入体验补齐。除 §4 斜杠参数动态候选依赖 A2 一个命令外，全部零 agent 改动。

---

## 1. 现状结构（改动前提）

`InputArea.tsx` 的补全菜单是**按 trigger 硬编码**的:state 类型只有 `{kind:"command"|"mention"}`,derive effect(216-253)用两个正则分别匹配 `/` 与 `@`,候选 memo(319-332)、keydown(509-541)、render(594-637)、`insertCompletion` 的替换正则(339)各处都按 kind 分叉。

**结论:先重构成 provider 链,再加 provider。** 否则加 4 种补全会把这 6 处各炸成 6 分支。

### 1.1 Provider 抽象（第一步，必做）

照 TUI `PromptActionAutocompleteProvider.getSuggestions` 的短路顺序（prompt-action-autocomplete.ts:131-204）设计：

```ts
// lib/completion/types.ts
interface CompletionItem {
  value: string;          // 插入文本
  label: string;          // 主显示
  description?: string;   // 副显示
  hint?: string;          // 尾部 usage/ghost 提示
  icon?: CompletionIcon;
}
interface CompletionContext {
  text: string;
  cursor: number;
  cwd: string;
}
interface CompletionProvider {
  id: string;
  /** 返回 undefined = 本 provider 不接管;返回 {range, items} = 接管(短路) */
  match(ctx: CompletionContext): { range: [number, number]; items: CompletionItem[] } | Promise<…> | undefined;
}
```

链顺序（严格照抄 TUI，避免行为分歧）：

1. `slashArgProvider` — 命令允许参数时的子命令/动态候选
2. `githubRefProvider` — `#123`
3. `promptActionProvider` — `#` 动作菜单（本轮不实现，占位保序）
4. `internalUrlProvider` — `skill://` 等 scheme（现有 6 项硬编码升级为 provider）
5. `emojiProvider` — `:name`（受 `emojiAutocomplete` 设置门控）
6. `baseProvider` — 斜杠命令名 + `@` 文件（现有实现迁入）

**性能**:`match` 按序调用,首个返回非 undefined 者短路;异步 provider(文件、动态参数)内部 debounce + 缓存,并以 `range` 判定结果是否已过期（光标移动后丢弃）。菜单渲染上限 12 项（与 TUI `MAX_SUGGESTIONS` 一致）。

---

## 2. 队列简写与枚举拆分

### 2.1 语义（逐字移植，不重新设计）

来源 `modes/queue-input.ts`(全 **133** 行):

```ts
const QUEUE_PREFIXES = ["->", "=>"];                                    // 两者语义相同
export const QUEUE_LIST_MARKER_RE = /^([\t ]*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/;
const CANONICAL_ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;

parseQueueShorthand(text)   // 命中前缀 → slice 后 trim。裸 `->` 得 "" 但仍 defined
```

拆分规则(`parseEnumeratedList` :95-111):≥2 项;**所有项同缩进**（不同缩进的行成为上一项的续行）;标点统一;序列必须连续——全十进制走十进制解码，否则标记须**全大写或全小写**且按 canonical Roman（含减法记数）或 base-26 字母(A=1…Z=26,AA=27)连续 +1。任一解码失败或步长非 1 → 不算列表,退化为单条。

`splitQueuedMessages`(:119-133):每项内容 + 到下一项之间的行 join 后 trim;尾部空串弹出;`every(Boolean)` 不成立则返回 `[source]`。

**裸前缀不入队(修正)**:`parseQueueShorthand("->")` 返回 `""`(defined),但 `#queueForYield` 对空 body **且无图片**时走 usage 警告分支、**不入队**(input-controller.ts:1186-1190);只有附了图片才入队(单条空内容项)。原文"仍入队"是错的。

### 2.2 分派语义（关键，容易做错）

TUI `#queueForYield`(input-controller.ts:**1177-1267**):

- `startImmediately = !isStreaming && queuedMessageCount === 0`
- 首项**两条路**:有 `ctx.onInputCallback` 时走 `onInputCallback(startPendingSubmission({streamingBehavior:"followUp"}))`,否则直接 `session.prompt(..., {streamingBehavior:"followUp"})`(:1224-1250)。两条路的 `streamingBehavior` 都是 `"followUp"`。
- 其余项：**逐条** `followUp`
- **图片只附在首项**(:1242-1246)
- 压缩中：全部推入 `compactionQueuedMessages`(mode:"followUp"),图片仅 index 0(:1204-1217)
- 失败处理(:1253-1269):一条都没成功 → 恢复原草稿+图片；部分成功 → 把剩余项重新编号成 `=>\n1. …`(**3 空格续行缩进**)写回草稿

**GUI 障碍**:审计发现 `preload` 的 `prompt()` **丢掉了 wire 的 `streamingBehavior` 字段**。必须先补上，否则首项行为与 TUI 不一致。

**另一个坑**:`session.followUp` 对扩展命令文本会抛错(agent-session.ts:5508-5510)。拆分后逐条预检:若某条以扩展命令名开头,该条改走 `prompt`,或整批拒绝并明确提示（选前者，更贴近用户意图）。

### 2.3 GUI 呈现

- **实时高亮(方案修正)**:原方案"textarea 上叠 `pointer-events:none` 高亮层"有一个硬问题:TUI 的高亮是**宽度改变型替换**(`->` 两字符换成 `Queueing ➤` 标签,custom-editor.ts:469-491),而叠加层要求**逐字符对齐** textarea 的度量。宽度一变就全行错位,再叠上 auto-grow(InputArea.tsx:211-213)、软换行、IME 合成中文本、字体回退,对齐几乎不可能长期稳定。
  **决策:不做字符级叠加层。** 改用两个更稳的信号(合计已达成 TUI 的意图——让用户知道"这会入队"):
  1. **前缀芯片**:检测到 `->`/`=>` 开头时,在 composer 左上角(或发送按钮旁)显示 `➤ 队列` 芯片。零对齐要求。
  2. **拆分预览徽章**(下一条),覆盖"缩进/标点没写对导致没拆"的困惑。
  这么做放弃了列表标记的 accent 着色。可接受:它是装饰性的,而错位是功能性缺陷。
- **拆分预览**:检测到 N 项列表时,发送按钮旁显示 `将拆分为 N 条` 徽章。TUI 没有这个——GUI 有空间，且能预先消除"以为拆了其实没拆"的困惑（缩进/标点敏感是已知陷阱）。
- **自动换行**:TUI 在缓冲区恰好等于 `->` 且光标在 0:2 时插入换行(custom-editor.ts:1001-1007)。GUI 照做,条件相同（仅整个 buffer 就是前缀时，不在中途触发）。
- **历史记录**:TUI 存**原始** `->…` 文本(historyText),分派用解析后的 body。GUI 的 input-history 同样存原文。

---

## 3. 大粘贴处理

### 3.1 两级阈值（TUI 有两个独立阈值，不要混为一个）

| 阈值 | 值 | 作用 |
|---|---|---|
| marker 折叠 | `> 10 行 或 > 1000 字符`(editor.ts:2010) | 是否折叠成 `[Paste #N]` |
| 菜单弹出 | `paste.largeMenuThreshold`,默认 **100 行**(settings-schema.ts:1851) | 是否弹三选项菜单;0 = 禁用菜单但仍折叠 |

后果：单行超长粘贴（字符多、行少）**跳过菜单直接折叠**。GUI 必须复刻这个差异。

### 3.2 marker 与 blob

- 文本:`[Paste #${id}, +${lineCount} lines]`(>10 行)或 `[Paste #${id}, ${chars} chars]`。
- 存储:TUI 是 editor 实例内的 `Map<number,string>` + 计数器,**纯内存**。GUI 同样用内存 Map(`lib/paste-blobs.ts`),**不进 zustand**(§15.3.5)。
- **投递方式:提交时内联展开**——marker 被替换回原文,然后才发 RPC。`prompt` 与 `followUp` 两条路径都必须展开(TUI 曾因 Ctrl+Q 路径漏展开留下 regression #3737)。
- 清理:提交后清空 buffer 与 blob map。

### 3.3 三个动作（GUI 形态调整）

TUI 是模态选择器（标题 `Pasted N lines`,Esc = 内联）。GUI 改为**粘贴处就地出现的 inline 卡片**,展示行数/字符数 + 首尾各 3 行预览 + 三个按钮:

| 动作 | 行为 | 备注 |
|---|---|---|
| 内联粘贴 | 插入 `[Paste #N]` marker(仍折叠) | 默认;Esc / 点外部 = 此项 |
| 包装为附件块 | 内容包 `<attachment>…</attachment>` 后折叠 | TUI `wrapPasteInAttachmentBlock` |
| 存为文件 | 写 `local://paste-N.md`,编辑器插入**字面 URI** | 见下 |

**"存为文件"的多窗口风险**:TUI 写入 `resolveLocalRoot(artifactsDir, sessionId)`,文件名 `paste-${++counter}.md` 跳过已存在;计数器是 per-InputController。**两个 GUI 窗口同会话会撞名**。
**对策**:GUI 不自己编号——新增一个 RPC(归入 A 批)`write_local_paste {content}` → agent 侧分配文件名并返回实际名。或退化方案：GUI 主进程写入前先 `fs.readdir` 探测 + 随机后缀。**选 RPC 方案**:文件属于会话 artifacts,归 agent 所有(§15.3.3)。

### 3.4 图片粘贴不受影响

现有 `handlePaste`(577-582)只处理图片文件。文本分支是新增，两者互不干扰：先判图片，无图片再判文本大小。

---

## 4. 补全 providers

### 4.1 斜杠参数补全

**线上已有的**(`RpcAvailableSlashCommand` rpc-types.ts:235-242):`subcommands[].{name,description,usage}`、`input.hint`。静态子命令下拉与静态 ghost 提示**现在就能做**。

**线上没有的**:`allowArgs`、动态候选(`/mcp` 的 server 名、`/move` 的目录)、动态描述(如 "Model: provider/id")。

**方案**:A2 追加 `allowArgs` + `hasDynamicArgCompletion` 两个布尔字段与 `get_command_arg_completions` 命令(见 16 §3.4)。GUI 行为:

```
输入 `/cmd` + 空格
  ├─ allowArgs === false 且已有非空参数 → 关闭菜单(TUI 是 hard null)
  ├─ 有 subcommands → 前缀过滤展示 {name, description, hint:usage}
  ├─ hasDynamicArgCompletion → debounce 120ms 请求 get_command_arg_completions
  └─ 仅 input.hint → 只显示 ghost 提示,不弹菜单
```

**动态描述降级**:GUI 用静态 `description`。TUI 的 `getTuiAutocompleteDescription`(如 "Compact: context 42% used")需要 per-session 求值通道,本轮**不做**——但 GUI 已在别处显示 context% (TitleBar/StatusFooter),信息不丢失。

### 4.2 Emoji

**数据源**:静态离线 JSON(`modes/data/emojis.json`,**32.7KB**,按首字母分桶预排序)+ 手维护 emoticon 表(**42 条**,longest-first:`:'-(`、`>:-(`、`:-)`、`</3`、`xD`…,emoji-autocomplete.ts:13-56)。**无网络、无运行时缓存**。

**GUI 实施**:
- 把该 JSON 复制进 GUI 资源（或从 agent 包读取——但 GUI 不能 runtime import `@oh-my-pi/*`，所以**复制**，并在 `scripts/` 加一个同步脚本记录来源）。
- **懒加载**:`await import("./data/emojis.json")` 首次触发时加载,不进 eager chunk(§15.3.5)。
- 触发规则(extractTrigger,emoji-autocomplete.ts:100-129):向左扫名字字符,要求一个 `:` 且其左边界是 起始/空格/tab/换行/**`\r`**/`(`/`[`/`{`/`>`。
- **至少输入 1 个字母才弹**(裸 `:` 不弹)。emoticon 字面量优先,再前缀扫桶,上限 12。
- **两处联动**(TUI 有,GUI 必须一并做,否则行为分歧):
  1. `:name:` 在**输入闭合冒号时**就地替换成字符。
  2. emoticon 在其后输入空格/tab/换行时替换（保留终止符）。
  3. **提交时**对全文再扫一遍 emoticon(`expandEmoticons`,input-controller.ts:617)——只做弹窗补全会与 TUI 分歧。
- 受 `emojiAutocomplete` 设置门控（默认 true）。

### 4.3 GitHub `#ref`

**无网络**(候选本地生成)。正则(github-ref-autocomplete.ts:41):

```
/(?:^|[\s"'`(<=])(?:(pr|pull|issue)(\s+))?#([1-9]\d*)$/i
```

边界要求排除 `owner/repo#N`、`foo#N`、`C#12`、URL fragment。未限定类型时**同时**给 `pr://N` 与 `issue://N`(编号空间共享,输入时无法判定);限定了(`pr #12`)只给对应项。接受后 token 改写为 `pr://N`/`issue://N` + 尾随空格。真正解析推迟到 read 工具的 `InternalUrlRouter` → `gh`。

非数字的 `#…` 落到 `#` 动作菜单(本轮不实现,直接不接管)。

### 4.4 Ghost 提示（inline hint）

TUI 在光标后渲染 dim 文本(editor.ts:928-1063),内容来自 provider 的 `getInlineHint`。GUI 用 textarea 后方的绝对定位 span(与 §2.3 的高亮层同一套度量基础设施,一次建好两处复用)。

来源优先级:斜杠子命令剩余字符/usage 参数 > `input.hint`。**只在无候选菜单打开时显示**,避免视觉冲突。

---

## 5. Ctrl+G 编辑器（GUI 原生形态）

### 5.1 与 extension `editor` 通道的区分（必须分清）

审计明确了两件不同的事：

| | Ctrl+G | `extension_ui_request method:"editor"` |
|---|---|---|
| 发起方 | 用户 | agent/扩展 hook |
| 作用对象 | 本地草稿 | 扩展要求编辑的内容 |
| 过 RPC | **不过**(TUI 里纯本地) | 过(rpc-types.ts:1067-1074) |
| GUI 现状 | 无 | 已实现(`ExtensionDialog` 的 editor 面) |

**不要把两者合并。** Ctrl+G 是纯客户端功能。

### 5.2 设计

主形态:**全屏编辑对话框**。CodeMirror **已在渲染进程使用**(`ExtensionDialog.tsx:455-481` 的 `EditorView`),但那里只配了 `lineWrapping` + json 语言,**没有 keymap**——所以本项要自带 keymap/history/markdown 配置,不能假装"复用现成配置"。

- 打开:⌃G(见 §6 键位表);预填当前草稿的**展开后**文本(TUI 用 `getExpandedText()`——即 paste marker 要展开,否则用户在编辑器里看到的是 `[Paste #1]`)。
- 关闭:⌘↵/保存 → 写回草稿;Esc → 丢弃(有改动时二次确认)。
- **写回后 marker 状态**:展开后的文本写回草稿意味着 blob map 里对应项必须**清除**。TUI 的提交期展开是"按 map 查表替换"(editor.ts:1684-1688),不清就会二次展开出重复内容。
- 次要出口:对话框里一个"用外部编辑器打开"按钮,走 `$VISUAL`/`$EDITOR`(逻辑照 `utils/external-editor.ts` 契约:temp 文件 `omp-editor-<snowflake>.omp.md`、exit 0 才读回、去掉恰好一个尾随换行、finally 删除)。由 GUI **主进程** spawn(渲染进程无 spawn 权限),经新 IPC `editor:openExternal`。$EDITOR 未设置时该按钮禁用 + tooltip。

---

## 6. 键位补齐与重映射

### 6.1 补齐清单

GUI 现有(App.tsx **264-330**,raw if 链):⇧Tab 思考等级(**唯一做了焦点门控的**)、⌃P 模型前进、⇧⌃P(借道前进,A1 修,TODO 在 :283-291)、⌥R 重试、⌥↑ dequeue、⌥⇧P plan、**⌃O** 工具展开(:327-328,**不是** ⌃⇧O)、⌘K 面板。

补齐（TUI 有、GUI 缺；已按桌面惯例调整冲突项）。**交付状态（2026-08-05,阶段 1)**:⌃T、⌃↵、⌥M、⌥A、/hotkeys 面板已交付并新增 ⌘/ 键；⌥⇧M 未做——核实后 GUI 的 `set_model` 本来就是会话级生效，ModelPicker 已覆盖"临时模型"语义，单独键位是重复;⌃Q 让位 ⌃↵;⌥⇧L/⌥⇧C 维持"不做"。

| TUI | 动作 | GUI 键位 | 备注 |
|---|---|---|---|
| ⌃T | 思考块显隐 | ⌃T | 无冲突 |
| ⌃Q / ⌃↵ | 作为 follow-up 发送 | ⌃↵ | ⌃Q 在桌面易撞;GUI 已有 send-mode 切换,此键是快捷路径 |
| ⌥M | 模型选择器 | ⌥M | 打开 ModelPicker |
| ⌥P | 临时会话模型 | ⌥⇧M | ⌥P 与 ⌥⇧P(plan)相邻易误触;改用 ⌥⇧M 归入模型族 |
| ⌥A / ⌃S | Agent Hub | ⌥A | ⌃S 在桌面 = 保存,不用 |
| ⌥⇧L | 复制当前行 | — | **不做**:GUI 有每消息复制按钮,行级复制在 textarea 里由系统承担 |
| ⌥⇧C | 复制整个草稿 | — | 同上 |
| ⌃Z 挂起 / ⌥L 重置显示 | — | — | **不适用**桌面 |

### 6.2 `/hotkeys` 面板

TUI 的 `buildHotkeysMarkdown`(utils/hotkeys-markdown.ts)是**固定三段 markdown**(Navigation / Editing / Other),动态部分靠 `keybindings.getDisplayString(action)`。其中若干行是终端专属（挂起、重置显示、`/dev/tty` 外部编辑器、followUp 和弦）。

**GUI 形态**:可搜索的快捷键面板(不是 markdown 文本)。分组表格,每行 = 动作描述 + 当前绑定 chip + (§6.3 后)改绑按钮。**复用 TUI 的 action-id 列表**作为条目来源,但**不移植其英文散文**——终端专属条目直接不列。

### 6.3 重映射层

**关键事实**:`~/.omp/agent/keybindings.yml` **对 GUI 完全无效**。它由 agent 进程的 `KeybindingsManager.create()` 加载,只被 TUI 按键分派消费;`omp --mode rpc-ui` 根本不解析按键。GUI 的键位是 Electron accelerator + renderer keydown。

**决策:GUI 重映射是 GUI-local 的**,存 `~/.omp/gui/` 偏好(既有例外范围内),**不写 keybindings.yml**。理由:写了也没人读,且会让用户误以为两端同步。

复用 TUI 的**action-id 命名**(`app.model.cycleForward` 等)以便用户心智迁移,但只收录 GUI 实际支持的动作。

实现要点：
- 数据:`Record<ActionId, string[]>` 覆盖表存 ui store + prefs。
- 匹配:启动/变更时把覆盖表 + 默认表编译成一个 `Map<chordString, ActionId>`;keydown 时 O(1) 查表(§15.3.5),**不遍历配置**。
- 冲突检测:`getConflicts()` **不在** coding-agent 的 `keybindings.ts` 上,而在 pi-tui 基类 `KeybindingRegistry`(packages/tui) 上;coding-agent 的 manager 只是持有它。**且生产代码从未调用**(仅测试)。GUI 的重映射 UI 会是第一个真实消费者——语义照搬:同一 chord 被多个**用户绑定**占用即冲突。TUI **不**检测"用户 chord 遮蔽了另一动作的**默认** chord",GUI 应当额外检测并警告（真实可用性改进）。
- 用户绑定**替换**该动作的默认列表（不做并集），与 TUI 一致。
- 保留既有守卫:`defaultPrevented`、焦点在输入框、`[role=dialog]` 打开时（0.3.x 修过 Esc 误中断运行 turn 的问题，不要退化）。

---

## 7. 渲染侧小项

### 7.1 task-list checkbox

`SANITIZE_SCHEMA` 是**完全替换** default(hast-util-sanitize 的 `{...defaultSchema, ...options}` 浅合并已在 node_modules 核实),`tagNames` 不含 `input` 导致 GFM 勾选框被剥掉。

**关键前提**:管线是 **rehype-raw 先解析原始 HTML,再 sanitize**。所以放行 `input` 后,模型输出里**手写的** `<input>` 也会活下来——不只是 remark-gfm 生成的那个。因此不能只放行标签名。

**改动(加固版,值级白名单)**:

```ts
tagNames: [...existing, "input"],
attributes: {
  ...existing,
  // 值级 pin:只有 type="checkbox" 通过,其它 type 值被剥
  input: [["type", "checkbox"], "checked", "disabled"],
},
```

`[["type","checkbox"]]` 是 hast-util-sanitize 的**属性值白名单**语法。缺了它,模型输出的 `<input type="password">`、`type="file"`、`type="text"` 都会渲染出真实可交互控件。

**并且必须加渲染层兜底**:`COMPONENTS` 映射目前**没有** `input` 覆盖,所以 `disabled` 只是"来自输入的建议",不是强制。加:

```tsx
input: (props) => <input {...props} type="checkbox" disabled readOnly tabIndex={-1} />
```

双层:sanitize 限制值域,组件强制只读。勾选状态来自模型输出,点击无处可存,GFM 语义本来就是只读展示。

**验收测试要测类型混淆,不是 `onclick`**:`<input type="password">`、`<input type="file">`、`<input type="text" value="x">` 三条必须渲染不出可交互控件。只测 `onclick` 被剥是测错了地方(`on*` 早就在 strip 列表里)。

### 7.2 markdown 代码块行号

markdown 用的 `CodeBlock` 与工具渲染器用的是**两个不同组件**;后者已有行号槽。改动:让 markdown 的 CodeBlock 复用同一个行号槽实现(抽到 `lib/highlight.ts` 旁的共享组件),默认**关闭**,由 GUI 偏好开启——正文代码块加行号对散文阅读是干扰,但对贴代码场景有用,交给用户。

### 7.3 usage row 补字段

- **timestamp**:已在线上(GUI `shared/rpc-types.ts:676` `AgentMessage.timestamp`,MessageBubble chrome 已消费)。UsageRow 直接读。
- **TTFT(位置修正)**:`ttft` 挂在**消息对象上**,是 `duration` 的兄弟字段(TUI 侧 `event.message.ttft`,event-controller.ts:1258;chat-transcript-builder.ts:426)。RPC 是 `session.subscribe(event => output(event))` 逐帧原样转发(rpc-mode.ts:1012),所以**它今天就在线上**。
  **因此**:在 GUI `shared/rpc-types.ts` 的 `AgentMessage`(:660-700)声明 `ttft?: number`,`UsageRow` 读 `message.ttft`——与它已经在读的 `message.duration`(UsageRow.tsx:63)同一层。**不需要 agent 侧投影**。原设计"加到 usage 结构里 + 可能要 agent 改一行"是错的:usage 结构里没有这个字段,加上去也接不到数据。

### 7.4 read 工具分组

**语义**(components/read-tool-group.ts,857 行):
- **折叠判定**(readArgsCollapseIntoGroup 39-43):目标以 `xd://` 开头,**或** `InternalUrlRouter` 无法处理(即普通文件路径)。`skill://`、`agent://` 等**不**折叠。
- **跨消息累积**:一段连续 read 会跨多个 assistant completion 持续累积。**断组条件**:新出现的可见 assistant 文本/thinking 块（空 thinking 不算）、任何非 read 工具卡、user/custom/fileMention 消息、无法附着的 usage 行、turn 结束。
- 卡片:1 项 → `● Read <path>`;N 项 → 头部 `Read (N)` + 树形行(├─/└─)。路径显示含 selector 后缀、同文件 selector 合并(`path:1-5,7,20-25`)、`(corrected from X)` 后缀修正标注、`(⚠ N conflicts)` 徽章。
- usage 行挂在该请求**最后一个可见 read** 之下,且仅当该 turn 的调用**全是**可折叠 read 且 read 之后无可见内容。

**GUI 实施位置(修正)**:原文说"在 `buildHistoryRows` 里做"是**不完整的**。`buildHistoryRows` 只处理**已定稿**消息(ChatStream.tsx:179-183,memo 在 `messages` 身份上),正在跑的那一轮走的是 `StreamingRows` + tools store(:462-520)。read 分组要在流式期间就成形,必须**两条路各接一次,共用同一个纯函数**:

```
lib/read-group.ts  →  groupReadRows(rows): GroupedRow[]     // 纯函数,无状态
     ├─ buildHistoryRows 出口调用一次(定稿路径)
     └─ StreamingRows 渲染前调用一次(live 路径)
```

只接定稿路径 = 流式时逐条散开、turn 结束突然合并成卡片(视觉跳变);只接 live 路径 = 切走再切回就散了。TUI 同样是两条(event-controller 与 chat-transcript-builder),这不是可以省的重复。

**与既有 compact 折叠的关系(必须先定)**:GUI 已有 `ProcessGroup` 折叠机制(ChatStream.tsx:73-101,compact 模式下把过程行收起)。两者叠加会出现"卡片里再套折叠"。**决策:read 分组只在非 compact 模式生效**;compact 模式下 `ProcessGroup` 继续赢——它本来就把所有过程行收成一行,更彻底,再插一层 read 卡片没有增量价值。

**范围裁剪**:首版实现折叠判定、断组规则、N 项树形卡、selector 合并。**暂不做**:内容预览(受 `read.toolResultPreview` 控制)、conflict 徽章——这两项依赖 read 结果 details 的深层字段,先确认线上有无再决定,不确定就不做（避免造假字段）。

**实施留痕(2026-08-05,阶段 3 交付)**:按上述设计落地并 CDP 验证(Read (2) 树形卡实测)。**踩到一个必录的坑**:分组卡的每调用状态解析最初写成 `useToolsStore(store => { const map = new Map(); …; return map; })`——selector 每次返回新 Map,zustand 的 useSyncExternalStore 快照永远不同 → `forceStoreRerender` 死循环 → **React #185 白屏**(任何含 read 分组的会话一打开就崩)。修复:选择 `activeTools` 稳定 map 引用 + `useMemo` 派生。**纪律:selector 必须返回原始值或稳定引用,绝不分配新对象/新集合。**
