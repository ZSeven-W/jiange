package store

import (
	"context"
	"time"
)

// Comment is a doc comment (or a reply; ParentID set). The range is anchored
// to character op-ids so it survives concurrent edits; Quote keeps the text
// for display when the anchor can no longer be resolved.
type Comment struct {
	ID        int64     `json:"id"`
	DocID     int64     `json:"docId"`
	UserID    int64     `json:"userId"`
	UserName  string    `json:"userName"`
	ParentID  *int64    `json:"parentId,omitempty"`
	Block     string    `json:"block"`
	StartChar string    `json:"startChar"`
	EndChar   string    `json:"endChar"`
	Quote     string    `json:"quote"`
	Body      string    `json:"body"`
	Mentions  []int64   `json:"mentions,omitempty"`
	Resolved  bool      `json:"resolved"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Notification kinds: mention (@me in a comment), reply (answer to my
// comment), resolve (my comment resolved), restore (version restored by me?
// reserved), plus generic doc mentions reused for @doc links.
type Notification struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"userId"`
	DocID     int64     `json:"docId"`
	DocTitle  string    `json:"docTitle,omitempty"`
	ActorID   int64     `json:"actorId"`
	ActorName string    `json:"actorName,omitempty"`
	CommentID *int64    `json:"commentId,omitempty"`
	Kind      string    `json:"kind"` // mention | reply | resolve
	Read      bool      `json:"read"`
	CreatedAt time.Time `json:"createdAt"`
	Preview   string    `json:"preview,omitempty"` // comment body snippet
}

type CommentStore interface {
	AddComment(ctx context.Context, c Comment) (Comment, error)
	Comments(ctx context.Context, docID int64) ([]Comment, error)
	UpdateComment(ctx context.Context, c Comment) (Comment, error)
	DeleteComment(ctx context.Context, docID, id int64) error
	// CommentAuthor returns the comment's author (for reply/resolve notifications).
	CommentAuthor(ctx context.Context, docID, id int64) (int64, error)

	AddNotifications(ctx context.Context, items []Notification) error
	// Notifications lists a user's notifications, newest first.
	Notifications(ctx context.Context, userID int64, limit int) ([]Notification, error)
	UnreadCount(ctx context.Context, userID int64) (int64, error)
	// MarkRead marks the given ids read; empty slice marks everything.
	MarkRead(ctx context.Context, userID int64, ids []int64) error
}
