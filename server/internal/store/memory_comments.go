package store

import (
	"context"
	"sort"
	"time"
)

func (m *Memory) AddComment(_ context.Context, c Comment) (Comment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c.ID = int64(len(m.comments)) + 1
	if c.UserName == "" {
		if u := m.userByID(c.UserID); u != nil {
			c.UserName = u.Name
		}
	}
	now := time.Now()
	c.CreatedAt, c.UpdatedAt = now, now
	m.comments = append(m.comments, c)
	return c, nil
}

func (m *Memory) Comments(_ context.Context, doc int64) ([]Comment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Comment{}
	for _, c := range m.comments {
		if c.DocID == doc {
			out = append(out, c)
		}
	}
	return out, nil
}

func (m *Memory) UpdateComment(_ context.Context, c Comment) (Comment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, x := range m.comments {
		if x.ID == c.ID && x.DocID == c.DocID {
			c.CreatedAt, c.UpdatedAt = x.CreatedAt, time.Now()
			c.UserID = x.UserID
			m.comments[i] = c
			return c, nil
		}
	}
	return Comment{}, ErrNotFound
}

func (m *Memory) DeleteComment(_ context.Context, doc, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	// remove the comment and its replies
	out := m.comments[:0]
	removed := false
	for _, c := range m.comments {
		if c.DocID == doc && (c.ID == id || (c.ParentID != nil && *c.ParentID == id)) {
			removed = true
			continue
		}
		out = append(out, c)
	}
	m.comments = out
	if !removed {
		return ErrNotFound
	}
	return nil
}

func (m *Memory) CommentAuthor(_ context.Context, doc, id int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.comments {
		if c.ID == id && c.DocID == doc {
			return c.UserID, nil
		}
	}
	return 0, ErrNotFound
}

func (m *Memory) AddNotifications(_ context.Context, items []Notification) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, n := range items {
		n.ID = int64(len(m.notifications)) + 1
		n.CreatedAt = time.Now()
		if n.DocTitle == "" {
			if d := m.doc(n.DocID); d != nil {
				n.DocTitle = d.meta.Title
			}
		}
		if n.ActorName == "" {
			if u := m.userByID(n.ActorID); u != nil {
				n.ActorName = u.Name
			}
		}
		m.notifications = append(m.notifications, n)
	}
	return nil
}

func (m *Memory) Notifications(_ context.Context, userID int64, limit int) ([]Notification, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Notification{}
	for _, n := range m.notifications {
		if n.UserID == userID {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Memory) UnreadCount(_ context.Context, userID int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, x := range m.notifications {
		if x.UserID == userID && !x.Read {
			n++
		}
	}
	return n, nil
}

func (m *Memory) MarkRead(_ context.Context, userID int64, ids []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := len(ids) == 0
	match := map[int64]bool{}
	for _, id := range ids {
		match[id] = true
	}
	for i := range m.notifications {
		n := &m.notifications[i]
		if n.UserID == userID && !n.Read && (all || match[n.ID]) {
			n.Read = true
		}
	}
	return nil
}
