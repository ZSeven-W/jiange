# 协同安全墓碑回收（Horizon GC）与跨会话恢复验证报告（2026-11-19）

## 一、交付范围（P0 Slice 6）

本轮完成云文档协同引擎的 **客户端参与安全墓碑回收协议（Horizon GC Barrier）** 与 **跨标签页关闭 / 浏览器崩溃待确认草稿与标题同步恢复**：

1. **客户端参与的安全墓碑回收（Go / TypeScript 对等屏障）**：
   - [server/collab/state.go](server/collab/state.go)：新增 `Doc.TombstoneStats()`（统计存活字符数与字符墓碑数）与 `Doc.CompactAtBarrier(barrierClock uint64)`（在协同确认的 `barrierClock` 下确定性裁剪已删叶子字符墓碑与已删块冗余属性/标记，同时严格保留标记锚点、存活后代及分栏归档墓碑；保留原有 `Doc.Compact()` 无损行为以兼容所有既有快照契约）。
   - [packages/collab/src/doc.ts](packages/collab/src/doc.ts)：新增对等 `Doc.tombstoneStats()` 与 `Doc.compactAtBarrier(barrierClock)`，保证参与屏障的客户端与服务端裁剪出完全一致的墓碑集合。
   - [server/internal/syncsrv/gc-barrier.go](server/internal/syncsrv/gc-barrier.go)：新增 `room.CompactSnapshotAtSafeHorizon(ctx)`，在刷盘全部在线客户端 ACK 并检查每个在线连接 `c.acked >= horizon` 后，按 `barrierClock` 同步裁剪快照与内存副本并持久化压缩快照；若超 `GCWindow` 的离线副本稍后携旧墓碑引用重连，仍由 `room.repairFromLog` 从全量操作日志自动无损恢复。
   - [server/internal/syncsrv/gc-barrier_test.go](server/internal/syncsrv/gc-barrier_test.go) & [packages/collab/test/gc-barrier.test.ts](packages/collab/test/gc-barrier.test.ts)：覆盖在线客户端落后于 Horizon 时拒绝裁剪、全员确认后安全裁剪并缩减快照体积、保留标记锚点，以及超窗离线副本携陈旧墓碑引用触发无损日志修复的全链路验证。

2. **跨会话（关闭标签页 / 浏览器崩溃）待确认操作与标题恢复**：
   - [apps/web/src/lib/pending-ops-storage.ts](apps/web/src/lib/pending-ops-storage.ts)：新增 `createStorageLeaseLockProvider`（基于 `localStorage` 心跳租约 `jiange:pending-lease:v1:*` 的 `LockProvider` 降级实现，默认 15s TTL，在无 Web Locks 环境下于标签页关闭或崩溃后由新标签页安全接管遗留待同步草稿，且在租约存活期间拒绝抢占活跃标签页）与 `inspectCrossSessionDrafts`；`prepareBrowserPendingSession` 在 `navigator.locks` 不可用时自动启用该租约降级。
   - [apps/web/src/pages/title-auto-sync.ts](apps/web/src/pages/title-auto-sync.ts) & [apps/web/src/pages/doc-page.tsx](apps/web/src/pages/doc-page.tsx)：新增 `titleSyncDurableStorageKey`（`jiange:title-sync:v2:<user>:<doc>`，7 天 TTL）与 `titleSyncDurableStorage`，优先写入 `localStorage` 并在 `activate()` 时自动迁移旧版 `sessionStorage` `v1` 条目，使未确认的标题同步在完整关闭标签页或浏览器崩溃重开后仍能安全恢复与冲突校验。
   - [apps/web/src/lib/cross-session-recovery.test.ts](apps/web/src/lib/cross-session-recovery.test.ts)：验证无 Web Locks 场景下的租约互斥与崩溃后过期接管，以及清空 `sessionStorage` 模拟关页重开后的标题自动同步恢复。

---

## 二、自动化验证结果

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| Go 全量测试（含 `TestSafeTombstoneGCBarrierAndLosslessFallback`） | `cd server && go test ./...` | 通过 |
| `@jiange/collab` 单元测试（含 `gc-barrier.test.ts`） | `pnpm --filter @jiange/collab exec vitest run test/gc-barrier.test.ts` | 通过（2/2） |
| 跨会话恢复与既有存储/标题同步测试 | `pnpm --filter @jiange/web exec vitest run src/lib/cross-session-recovery.test.ts src/lib/pending-ops-storage.test.ts src/pages/title-auto-sync.test.ts` | 通过（3 文件，38/38） |
| 全仓库类型检查 | `pnpm typecheck` | 通过（7/7 包） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | 通过 |
| 全仓库前端/SDK 单元测试 | `pnpm test` | 通过 |

---

## 三、已知边界（留作 P1 运维增强）

- `JIANGE_ENABLE_CONDITIONAL_CANCEL` 灰度开关仍保留显式配置（默认 `false` 以满足既有配置契约 `config_test.go`），多实例滚动升级时的自动实例排空编排留作后续 P1 运维能力。
