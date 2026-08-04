# GUI 双上游 Git 工作流(omp 底座 + 自维护 GUI 发布库)

## 结构:两个 remote

| Remote | 地址 | 角色 |
|---|---|---|
| **upstream** | `git@github.com:can1357/oh-my-pi.git` | 原 omp 底座。只**拉**(特性同步源),不推。 |
| **origin** | `<你的 GUI 发布库>` | 自维护 GUI 发布库。只**推**(发布版本),是我们的 release。 |

设置(一次性):
```bash
git remote rename origin upstream                 # 已完成
git remote add origin <你的-GUI-库-URL>            # 你来加(GitHub 上建的空库)
```

## 分支策略

- **`main`** = GUI 发布线。内容是:omp 底座 + packages/gui + 对 omp 的必要修改(agent RPC 扩展等)。推到 `origin`,这就是发布版本。
- **`upstream/main`** = omp 上游,只读同步源。

首次建立发布线:
```bash
git add -A                                        # 暂存 packages/gui + omp 修改
git commit -m "feat(gui): omp GUI on omp 17.2.6 base"
git push -u origin main                           # 推到自己的发布库
```

## 特性同步(从 omp 拉取 → 融入 GUI)

定期(或 omp 发版时)跑一次:
```bash
bash packages/gui/scripts/sync-upstream.sh
```

脚本自动完成:
1. `fetch upstream` + 列出 incoming 提交。
2. `merge upstream/main`(冲突则停下让你解:解完 `SKIP_MERGE=1` 重跑)。
3. `bun install`(lockfile 可能动)。
4. omp **版本 bump** 时自动给新版本装 `pi_natives`(版本锁,见下)。
5. `gen:stats`(重新内嵌 stats 前端,否则 `/` 500)。
6. `build:omp` + `--smoke-test`(验证二进制)。
7. GUI `build` + `tsc` + `vitest`。

### 同步时的冲突处理原则
- **packages/gui/**:上游永远没有它 → 永不冲突,安全。
- **agent RPC 文件**(rpc-types/rpc-mode/rpc-extensions/…):我们的改动是**纯新增**(新命令、新 case),上游很少碰 → 基本不冲突;冲突时**两边都保留**(上游的新 handler + 我们的新命令)。
- **bun.lock**:自动重生成,不手动解。
- 解完冲突必须重跑 `build:omp` + `gen:stats`,否则二进制落后。

### 已知坑(本次踩过,脚本已覆盖)
- **pi_natives 版本锁**:二进制按 `~/.omp/natives/<version>/` 找 natives 且校验版本 sentinel。omp bump 版本后必须给新版本装 natives,否则起不来。脚本第 4 步处理(从官方 npm 包 `pi-natives-<tag>@<version>` 装;想要纯源码构建则需 rustup + `crates/pi-natives` 本地编)。
- **stats 前端**:omp 的 stats dashboard 前端要 `gen:stats` 内嵌,否则 `/` 500。脚本第 5 步处理。
- **oclif flag 命名**:camelCase flag key → `--camelCase` 显示;要 kebab `--no-open` 就把 flag key 写成 `"no-open"`。

## 发布(我们自己的版本)

- GUI 发布 = `main` 推到 `origin` + 打 tag + electron-builder 打包(可选):
  ```bash
  git tag -a gui-v0.2.0 -m "GUI v0.2.0 (omp 17.2.6)"
  git push origin main --tags
  bun --cwd=packages/gui run build   # renderer
  # electron-builder 打包 .app(需签名/公证时再配)
  ```
- `origin` 上的 tag = 我们的 GUI 版本号,**与 omp 版本解耦**(GUI vX.Y 基于 omp A.B.C,在 tag message 里注明底座版本)。

## 一句话

> omp 是底座(`upstream`,只拉);我们的 GUI 是产品(`origin`,只推)。每次 `sync-upstream.sh` = 一次特性同步:解 bug、融新特性进 GUI、顺带设计 GUI 侧的新功能/配置/逻辑,然后作为我们的发布版本推出去。
