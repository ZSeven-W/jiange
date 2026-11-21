package ai

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

var (
	// ErrInvalidTool is returned when registering a tool with an empty name or nil handler.
	ErrInvalidTool = errors.New("ai: invalid tool definition or handler")
	// ErrDuplicateTool is returned when registering a tool whose name is already registered.
	ErrDuplicateTool = errors.New("ai: tool already registered")
	// ErrToolNotFound is returned when invoking an unregistered tool name.
	ErrToolNotFound = errors.New("ai: tool not found")
)

// ToolDefinition matches the MCP tools/list schema.
type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// ToolHandler executes a single tool invocation with decoded JSON arguments.
type ToolHandler func(ctx context.Context, args map[string]any) (any, error)

type registeredTool struct {
	def     ToolDefinition
	handler ToolHandler
}

// ToolRegistry manages modular, opt-in AI/MCP tool registrations across Jiange domains.
type ToolRegistry struct {
	mu    sync.RWMutex
	tools map[string]registeredTool
}

// NewToolRegistry creates an empty ToolRegistry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{tools: make(map[string]registeredTool)}
}

// Register adds a tool to the registry, returning ErrDuplicateTool if the name already exists.
func (r *ToolRegistry) Register(def ToolDefinition, handler ToolHandler) error {
	name := strings.TrimSpace(def.Name)
	if name == "" || handler == nil {
		return ErrInvalidTool
	}
	def.Name = name
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tools[name]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateTool, name)
	}
	r.tools[name] = registeredTool{def: def, handler: handler}
	return nil
}

// RegisterAll invokes composable registration callbacks (e.g. sheet.RegisterTools) in order.
func (r *ToolRegistry) RegisterAll(registrars ...func(*ToolRegistry) error) error {
	for _, fn := range registrars {
		if fn == nil {
			continue
		}
		if err := fn(r); err != nil {
			return err
		}
	}
	return nil
}

// Unregister removes a tool by name, returning true if it existed.
func (r *ToolRegistry) Unregister(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.tools[name]; !ok {
		return false
	}
	delete(r.tools, name)
	return true
}

// List returns all registered tool definitions sorted alphabetically by name.
func (r *ToolRegistry) List() []ToolDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ToolDefinition, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t.def)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Call executes a registered tool by name.
func (r *ToolRegistry) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	r.mu.RLock()
	tool, ok := r.tools[name]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrToolNotFound, name)
	}
	return tool.handler(ctx, args)
}

// StringArg extracts a string argument from args, returning "" if absent or wrong type.
func StringArg(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

// BoolArg extracts a bool argument from args, returning false if absent or wrong type.
func BoolArg(args map[string]any, key string) bool {
	if v, ok := args[key].(bool); ok {
		return v
	}
	return false
}

// IntArg extracts an integer argument from JSON-decoded numbers (float64 or int).
func IntArg(args map[string]any, key string) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}
