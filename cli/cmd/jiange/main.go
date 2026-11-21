package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/ZSeven-W/jiange/cli/internal/engine"
	"github.com/ZSeven-W/jiange/cli/internal/mcp"
)

const version = "0.2.0"

var (
	stdin          io.Reader = os.Stdin
	stdout         io.Writer = os.Stdout
	stderr         io.Writer = os.Stderr
	exitFn                   = os.Exit
	listenAndServe           = http.ListenAndServe
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(stderr, "jiange: %v\n", err)
		exitFn(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		printUsage()
		return nil
	}
	switch args[0] {
	case "version":
		fmt.Fprintf(stdout, "jiange %s (Go native CLI & MCP Server)\n", version)
		return nil
	case "mcp":
		return runMCP(args[1:])
	case "sheet":
		return runSheet(args[1:])
	case "doc":
		return runDoc(args[1:])
	case "slides":
		return runSlides(args[1:])
	case "board":
		return runBoard(args[1:])
	case "base":
		return runBase(args[1:])
	default:
		return fmt.Errorf("unknown command %q (try: sheet, doc, slides, board, base, mcp, version)", args[0])
	}
}

func printUsage() {
	fmt.Fprintln(stdout, `jiange — Lightweight AI-Native Office CLI & MCP Server (Go)

Usage:
  jiange sheet  <inspect|query|patch|verify|convert> <file> [flags]
  jiange doc    <inspect|query|patch|verify|convert> <file> [flags]
  jiange slides <inspect|patch|verify|render>        <file> [flags]
  jiange board  <inspect|verify|render>              <file> [flags]
  jiange base   <inspect|query|patch|verify>         <file> [flags]
  jiange mcp    [--transport stdio|http] [--addr 127.0.0.1:8787]
  jiange version`)
}

func printJSON(v any) error {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func runMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(stderr)
	transport := fs.String("transport", "stdio", "MCP transport: stdio or http")
	addr := fs.String("addr", "127.0.0.1:8787", "HTTP listen address when --transport=http")
	if err := fs.Parse(args); err != nil {
		return err
	}
	srv := mcp.NewServer(version)
	if *transport == "http" {
		fmt.Fprintf(stderr, "jiange mcp listening on http://%s/mcp\n", *addr)
		return listenAndServe(*addr, srv.HTTPHandler())
	}
	return srv.ServeStdio(stdin, stdout)
}

func runSheet(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: jiange sheet <inspect|query|patch|verify|convert> <file> [flags]")
	}
	action, file := args[0], args[1]
	fs := flag.NewFlagSet("sheet", flag.ContinueOnError)
	fs.SetOutput(stderr)
	detail := fs.String("detail", "standard", "summary|standard|full")
	sheet := fs.String("sheet", "", "sheet filter")
	search := fs.String("search", "", "search text")
	onlyFormulas := fs.Bool("formulas", false, "only formula cells")
	onlyErrors := fs.Bool("errors", false, "only error cells")
	opsJSON := fs.String("ops", "[]", "JSON array of SheetOp")
	dryRun := fs.Bool("dry-run", false, "preview patch without saving")
	out := fs.String("out", "", "output file path")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	wb, err := engine.LoadWorkbook(file)
	if err != nil {
		return err
	}
	switch action {
	case "inspect":
		return printJSON(wb.Inspect(*detail))
	case "query":
		return printJSON(wb.Query(*sheet, *search, *onlyFormulas, *onlyErrors, 200))
	case "verify":
		return printJSON(wb.Verify())
	case "patch":
		var ops []engine.SheetOp
		if err := json.Unmarshal([]byte(*opsJSON), &ops); err != nil {
			return err
		}
		applied, diff, err := wb.Apply(ops, *dryRun)
		if err != nil {
			return err
		}
		if !*dryRun {
			target := *out
			if target == "" {
				target = file
			}
			if err := engine.SaveWorkbook(target, wb); err != nil {
				return err
			}
		}
		return printJSON(map[string]any{"ok": true, "applied": applied, "dryRun": *dryRun, "diff": diff})
	case "convert":
		if *out == "" {
			return fmt.Errorf("convert requires --out <path>")
		}
		return engine.SaveWorkbook(*out, wb)
	default:
		return fmt.Errorf("unknown sheet action %q", action)
	}
}

func runDoc(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: jiange doc <inspect|query|patch|verify|convert> <file> [flags]")
	}
	action, file := args[0], args[1]
	fs := flag.NewFlagSet("doc", flag.ContinueOnError)
	fs.SetOutput(stderr)
	detail := fs.String("detail", "standard", "summary|standard|full")
	search := fs.String("search", "", "search text")
	blockType := fs.String("type", "", "block type filter")
	opsJSON := fs.String("ops", "[]", "JSON array of DocOp")
	dryRun := fs.Bool("dry-run", false, "preview patch without saving")
	out := fs.String("out", "", "output file path")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	doc, err := engine.LoadDoc(file)
	if err != nil {
		return err
	}
	switch action {
	case "inspect":
		return printJSON(doc.Inspect(*detail))
	case "query":
		return printJSON(doc.Query(*search, *blockType))
	case "verify":
		return printJSON(doc.Verify())
	case "patch":
		var ops []engine.DocOp
		if err := json.Unmarshal([]byte(*opsJSON), &ops); err != nil {
			return err
		}
		applied, diff, err := doc.Apply(ops, *dryRun)
		if err != nil {
			return err
		}
		if !*dryRun {
			target := *out
			if target == "" {
				target = file
			}
			if err := engine.SaveDoc(target, doc); err != nil {
				return err
			}
		}
		return printJSON(map[string]any{"ok": true, "applied": applied, "dryRun": *dryRun, "diff": diff})
	case "convert":
		if *out == "" {
			return fmt.Errorf("convert requires --out <path>")
		}
		return engine.SaveDoc(*out, doc)
	default:
		return fmt.Errorf("unknown doc action %q", action)
	}
}

func runSlides(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: jiange slides <inspect|patch|verify|render> <file> [flags]")
	}
	action, file := args[0], args[1]
	fs := flag.NewFlagSet("slides", flag.ContinueOnError)
	fs.SetOutput(stderr)
	slideIdx := fs.Int("slide", 0, "0-based slide index")
	opsJSON := fs.String("ops", "[]", "JSON array of SlidePatchOp")
	dryRun := fs.Bool("dry-run", false, "preview patch without saving")
	out := fs.String("out", "", "output file path")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	deck, err := engine.LoadDeck(file)
	if err != nil {
		return err
	}
	switch action {
	case "inspect":
		return printJSON(deck.Inspect())
	case "verify":
		return printJSON(deck.Verify())
	case "patch":
		var ops []engine.SlidePatchOp
		if err := json.Unmarshal([]byte(*opsJSON), &ops); err != nil {
			return err
		}
		applied, diff, err := deck.Apply(ops, *dryRun)
		if err != nil {
			return err
		}
		if !*dryRun {
			target := *out
			if target == "" {
				target = file
			}
			if err := engine.SaveDeck(target, deck); err != nil {
				return err
			}
		}
		return printJSON(map[string]any{"ok": true, "applied": applied, "dryRun": *dryRun, "diff": diff})
	case "render":
		svg, err := deck.RenderSlideSVG(*slideIdx)
		if err != nil {
			return err
		}
		if *out != "" {
			return os.WriteFile(*out, []byte(svg), 0o644)
		}
		fmt.Fprintln(stdout, svg)
		return nil
	default:
		return fmt.Errorf("unknown slides action %q", action)
	}
}

func runBoard(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: jiange board <inspect|verify|render> <file> [flags]")
	}
	action, file := args[0], args[1]
	fs := flag.NewFlagSet("board", flag.ContinueOnError)
	fs.SetOutput(stderr)
	out := fs.String("out", "", "output file path")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	board, err := engine.LoadBoard(file)
	if err != nil {
		return err
	}
	switch action {
	case "inspect":
		return printJSON(board.Inspect())
	case "verify":
		return printJSON(board.Verify())
	case "render":
		svg := board.RenderSVG()
		if *out != "" {
			return os.WriteFile(*out, []byte(svg), 0o644)
		}
		fmt.Fprintln(stdout, svg)
		return nil
	default:
		return fmt.Errorf("unknown board action %q", action)
	}
}

func runBase(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: jiange base <inspect|query|patch|verify> <file> [flags]")
	}
	action, file := args[0], args[1]
	fs := flag.NewFlagSet("base", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tableID := fs.Int("table", 0, "table id")
	search := fs.String("search", "", "search keyword")
	opsJSON := fs.String("ops", "[]", "JSON array of BasePatchOp")
	dryRun := fs.Bool("dry-run", false, "preview patch without saving")
	out := fs.String("out", "", "output file path")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	b, err := engine.LoadBase(file)
	if err != nil {
		return err
	}
	switch action {
	case "inspect":
		return printJSON(b.Inspect())
	case "query":
		return printJSON(b.Query(*tableID, *search, 200))
	case "verify":
		return printJSON(b.Verify())
	case "patch":
		var ops []engine.BasePatchOp
		if err := json.Unmarshal([]byte(*opsJSON), &ops); err != nil {
			return err
		}
		applied, diff, err := b.Apply(ops, *dryRun)
		if err != nil {
			return err
		}
		if !*dryRun {
			target := *out
			if target == "" {
				target = file
			}
			if err := engine.SaveBase(target, b); err != nil {
				return err
			}
		}
		return printJSON(map[string]any{"ok": true, "applied": applied, "dryRun": *dryRun, "diff": diff})
	default:
		return fmt.Errorf("unknown base action %q", action)
	}
}
