package store

import "context"

// Actor identifies who caused a write, recorded on bt_events for record history.
type Actor struct {
	UserID int64  // 0 when anonymous
	Kind   string // "user" | "form"
}

type actorKey struct{}

// WithActor attaches the acting user (or anonymous form) to ctx.
func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFrom returns the actor attached by WithActor.
func ActorFrom(ctx context.Context) (Actor, bool) {
	a, ok := ctx.Value(actorKey{}).(Actor)
	return a, ok
}

// actorArgs returns the (actor_id, actor_kind) SQL arguments for ctx.
func actorArgs(ctx context.Context) (any, any) {
	a, ok := ActorFrom(ctx)
	if !ok || a.Kind == "" {
		return nil, nil
	}
	var id any
	if a.UserID != 0 {
		id = a.UserID
	}
	return id, a.Kind
}
