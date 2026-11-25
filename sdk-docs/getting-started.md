# 快速上手（5 分钟入门）

本指南覆盖 **4 条主流接入路径**，所有示例均基于真实导出的 `v0.2.0` API，可直接复制运行。

---

## 路径一：单包 Headless TypeScript SDK（Node.js / Edge / Browser）

每个业务域均可独立安装、零 UI 依赖运行。下面以 `@zseven-w/sheet-sdk` 为例完成 **CSV 导入 → AI `dryRun` 预演 → 原子写入与增量公式计算 → 确定性校验 → DEFLATE XLSX 导出**：

```bash
npm install @zseven-w/sheet-sdk
```

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

// 1. 从 CSV 初始化工作簿（亦支持 Workbook.create / Workbook.fromXlsx）
const wb = Workbook.fromCsv(
  "Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n",
  "Q4",
);

// 2. 创建自描述 AI 工具集（也可直接调用 wb.apply / wb.inspect / wb.verify）
const tools = createSheetTools(wb);

const ops = [
  {
    op: "setCells" as const,
    sheet: "Q4",
    cells: [
      { a1: "D1", raw: "Revenue" },
      { a1: "D2", raw: "=B2*C2" },
      { a1: "D3", raw: "=B3*C3" },
      { a1: "D4", raw: "=SUM(D2:D3)" },
    ],
  },
];

// 3. 先 dryRun 预演，确认 diff 与零错误后再提交
const preview = tools.execute("sheet_apply", { dryRun: true, ops });
console.log("dryRun:", preview);

tools.execute("sheet_apply", { ops, reason: "Add revenue column and total" });

// 4. 读取增量计算结果并执行零错误审计
console.log("Total Revenue (D4):", wb.sheet("Q4").getValue("D4")); // 13355
console.log("Diagnostics:", wb.verify()); // []

// 5. 导出 DEFLATE 压缩的 .xlsx 字节流
const xlsxBytes = await wb.toXlsxAsync();
console.log("XLSX size (bytes):", xlsxBytes.byteLength);
```

> 仓库内置了涵盖全部 5 个 Headless SDK 的端到端脚本 [`examples/ts-headless/demo.mjs`](../examples/ts-headless/demo.mjs)，可在仓库根目录直接运行：
> ```bash
> pnpm --filter @zseven-w/collab exec tsx ../../examples/ts-headless/demo.mjs
> ```

---

## 路径二：WebGPU / WebGL2 + 虚拟列表 UI 嵌入

所有 5 个 UI 包（`@zseven-w/sheet-ui`、`@zseven-w/doc-ui`、`@zseven-w/slides-ui`、`@zseven-w/whiteboard-ui`、`@zseven-w/base-ui`）均提供 **3 种框架无关接入方式**，且底层零 Canvas 2D。

```bash
npm install @zseven-w/sheet-ui @zseven-w/sheet-sdk
```

### 方式 A：Vanilla 原生挂载（`mount*View`）

```ts
import { Workbook } from "@zseven-w/sheet-sdk";
import { mountSheetView } from "@zseven-w/sheet-ui";

const wb = Workbook.fromCsv("Region,Q1,Q2\nNorth,120,150\nSouth,90,130\n", "Sales");
const container = document.getElementById("app")!;

// mountSheetView / mountSlidesView / mountWhiteboardView / mountBaseView 为 async
// mountDocView 为同步返回 MountedDocView
const view = await mountSheetView(container, wb, {
  sheet: "Sales",
  gpu: { prefer: "webgpu" }, // 自动按 WebGPU -> WebGL2 -> Headless 降级
});

window.addEventListener("resize", () => {
  view.resize(container.clientWidth, container.clientHeight);
});

// 卸载释放 GPU 资源与事件监听
// view.dispose();
```

### 方式 B：React 零额外体积适配器（`./react`）

React 作为可选 peer dependency，通过工厂函数注入宿主 `React` 实例，避免重复打包 React：

```tsx
import * as React from "react";
import { Workbook } from "@zseven-w/sheet-sdk";
import { createSheetViewComponent } from "@zseven-w/sheet-ui/react";

const SheetView = createSheetViewComponent(React);

export function BudgetSheet({ workbook }: { workbook: Workbook }) {
  return <SheetView workbook={workbook} sheet="Sales" width={1024} height={600} />;
}
```

### 方式 C：SSR 安全的标准 Web Component（`<jiange-*>`）

适合 Vue、Svelte、Angular、Lit 或原生 HTML 页面：

```ts
import { Workbook } from "@zseven-w/sheet-sdk";
import { defineSheetElement, type JiangeSheetElement } from "@zseven-w/sheet-ui";

// 在 Node.js / SSR 中安全返回 false，在浏览器中注册 <jiange-sheet>
defineSheetElement();

const el = document.createElement("jiange-sheet") as JiangeSheetElement;
el.style.cssText = "display:block;width:100%;height:600px;";
el.workbook = Workbook.fromCsv("Task,Hours\nDesign,12\nBuild,24\n", "Plan");
document.body.appendChild(el);
```

> 想免配置直观体验所有 5 个 UI 包与 GPU 实时遥测？在仓库根目录运行零打包器的交互式 Playground：
> ```bash
> pnpm -r build
> node examples/ui-playground/serve.mjs   # 访问 http://127.0.0.1:4173
> ```

---

## 路径三：Go 原生 CLI & MCP Server（AI 客户端即插即用）

`cli/` 编译为**零外部依赖单静态二进制**，无需 Node.js 环境，同时支持本地文件批处理、MCP 协议服务及远程后端操控。

### 1. 构建二进制

```bash
cd cli
go build -trimpath -ldflags="-s -w" -o jiange ./cmd/jiange
./jiange version
```

### 2. 本地 Office 文件读写、补丁与渲染

```bash
# 电子表格：检查 / 搜索 / 原子补丁 / 公式校验 / 格式转换
jiange sheet inspect budget.xlsx --detail full
jiange sheet query budget.xlsx --search "Revenue"
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange sheet verify budget.xlsx

# 文档 / 幻灯片 / 白板 / 多维表格
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide-0.svg
jiange board render arch.mmd --out arch.svg
jiange base query crm.json --search "Enterprise"
```

### 3. 启动 MCP Server（`stdio` 与 Streamable HTTP）

- **Stdio 模式**（Claude Desktop / Cursor / Codex / Antigravity 本地接入）：
  ```json
  {
    "mcpServers": {
      "jiange": {
        "command": "/usr/local/bin/jiange",
        "args": ["mcp", "--transport", "stdio"]
      }
    }
  }
  ```
- **Streamable HTTP 模式**（支持 `OPTIONS` CORS、`POST /mcp`、`GET /mcp` SSE、`DELETE /mcp` 会话销毁与 `Mcp-Session-Id`）：
  ```bash
  jiange mcp --transport http --addr 127.0.0.1:8787
  ```

### 4. 连接远程 `sdk/go/server` 实例（`jiange remote`）

```bash
export JIANGE_SERVER=http://127.0.0.1:8080
export JIANGE_TOKEN=your-bearer-token

jiange remote health
jiange remote tools
jiange remote call --tool sheet_inspect --args '{"id":"q1-budget","detail":"standard"}'
jiange remote post --path /sheets --body '{"id":"q1-budget","title":"Q1 Budget"}'
```

---

## 路径四：Go 后端 SDK 嵌入 + PostgreSQL 持久化

`github.com/ZSeven-W/jiange/sdk/go` 是纯 Go 1.23 标准库实现的后端嵌入套件，`github.com/ZSeven-W/jiange/sdk/go-pgstore` 是零第三方依赖的 PostgreSQL `database/sql` 持久化适配器。

```bash
go get github.com/ZSeven-W/jiange/sdk/go
go get github.com/ZSeven-W/jiange/sdk/go-pgstore
go get github.com/jackc/pgx/v5/stdlib
```

### 挂载到 `net/http`（含 PostgreSQL + Bearer 鉴权 + RBAC）

```go
package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/ZSeven-W/jiange/sdk/go/server"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
	pgstore "github.com/ZSeven-W/jiange/sdk/go-pgstore"
)

func main() {
	ctx := context.Background()

	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	store, err := pgstore.New(db, pgstore.WithTableName("jiange_sdk_records"))
	if err != nil {
		log.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		log.Fatal(err)
	}

	jiange := server.New(server.Config{
		Store: store,
		Auth: storage.NewBearerTokenAuth(map[string]storage.Principal{
			"prod-token": {ID: "svc-1", Name: "API Bot", Roles: []string{"admin"}},
		}),
		Authz:   storage.NewRoleAuthorizer(nil), // viewer->read, editor->read/write, admin->all
		Version: "0.2.0",
	})

	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", jiange))
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

### 在 Gin / Chi 中复用同一 `http.Handler`

```go
// Gin
r.Any("/api/v1/*any", gin.WrapH(http.StripPrefix("/api/v1", jiange)))

// Chi
r.Mount("/api/v1", jiange)
```

> 可在仓库内运行零依赖进程内自检示例 [`examples/go-backend/main.go`](../examples/go-backend/main.go)：
> ```bash
> cd examples/go-backend && go run . --check
> ```
