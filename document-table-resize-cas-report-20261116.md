# 文档表格首次列宽调整：并发提交验证

日期：2026-11-16。本报告覆盖表格列宽的一个并发改进，不代表飞书文档已全部对齐。

## 本次实现

- 在线、账号和文档有效、浏览器支持跨页面锁且文档同步完成时，首次调整通过服务器当前历史代际与序列号条件提交；请求保存在账号和文档隔离的本地日志中，服务端保存可查询回执；响应不确定时可核对或重试同一请求。
- 有先前操作未确认时，保留拖动预览并等待最多两秒；等待期间可取消。同步完成后采用条件提交，超时则保留既有本地协作写入行为并提示。
- 服务端已接受但响应丢失后，等本地副本观察到该操作和回执才确认结果。后续不同正文编辑的撤销记录保持在列宽操作之后；同表格的后续单元格编辑及首次迁移也覆盖了撤销/重做测试。若后续操作覆盖列宽，保留受保护的撤销记录，防止误撤销更早的操作。
- 协同 SDK 新增异步撤销标记定位能力；历史已被撤销/重做、锚点被淘汰或表格状态无法确认时不强行重排，并向用户提示可能无法撤销。

## 截图

- [并发版本过期被拒绝](jiange-document-table-resize-cas-conflict-20261116.png)
- [不同浏览器同时调整列宽](jiange-document-table-resize-cas-cross-browser-20261116.png)
- [服务端已接受但响应丢失后的恢复](jiange-document-table-resize-cas-recovery-20261116.png)
- [等待回执时编辑同一表格](jiange-document-table-resize-cas-cell-20261116.png)
- [等待先前操作同步，可取消](jiange-document-table-resize-wait-sync-20261116.png)
- [离线调整](jiange-document-table-resize-offline-20261116.png)
- [后续协作者修改后的保护提示](jiange-document-table-resize-cas-superseded-20261116.png)

以上是隔离环境中的 Jiange 截图，非飞书实页对比。相对文件位置见当前目录。

## 复现与验证

`verify-document-table-resize-cas*.mjs` 使用独立浏览器、账号、服务端和 PostgreSQL：暂停首次条件请求，让另一端先编辑正文或调整列宽，验证过期请求被拒；另行模拟响应丢失、对方在已接受后继续调整、等待期间输入正文和修改同一表格，验证回执、顺序及受保护的撤销。`verify-document-table-resize-wait-sync.mjs` 检查未确认操作同步前不发送条件请求和取消等待；`verify-document-table-resize-owner-lock.mjs` 验证等待期间同账号标签页互斥以及取消后释放；`verify-document-table-resize-wait-timeout.mjs`、`verify-document-table-resize-offline.mjs`、`verify-document-table-resize-no-locks.mjs` 与 `verify-document-table-resize-storage.mjs` 检查超时、离线和日志写入失败但可确认未提交时的保留与恢复；若日志也无法读取，则保持待核对状态，避免重复提交。覆盖面、最终测试及构建见本次提交结果。

## 未完成边界

条件提交只保证服务器在该操作提交时检查的版本。离线、同步等待超时、浏览器不支持跨页面锁或旧服务端等情况下沿用普通协作写入，仍可能与在途操作或旧客户端后写竞争；即使条件提交成功，旧客户端随后发送的无条件操作仍可能覆盖。若等待回执期间用户改变撤销/重做栈，或历史锚点被淘汰，则无法保证添加该次撤销记录，会显示提示。用户刷新后本地撤销历史不持久。真实手机及飞书实页仍未在本轮比对。
