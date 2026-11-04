package store

import (
	"context"
	"strings"
	"sync"
	"time"
)

type session struct {
	userID  int64
	expires time.Time
}

// Memory is a thread-safe in-memory Store for tests and local experiments.
type Memory struct {
	mu            sync.Mutex
	users         []User
	workspaces    []Workspace
	members       map[int64][]int64 // user -> workspace ids
	sessions      map[string]session
	d             memDocs
	sh            memShare
	b             memBase
	comments      []Comment
	notifications []Notification
	favorites     map[int64][]int64
}

func NewMemory() *Memory {
	return &Memory{members: map[int64][]int64{}, sessions: map[string]session{}, favorites: map[int64][]int64{}}
}

func (m *Memory) CreateUser(_ context.Context, email, name, hash string) (User, Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if strings.EqualFold(u.Email, email) {
			return User{}, Workspace{}, ErrConflict
		}
	}
	u := User{ID: int64(len(m.users) + 1), Email: email, Name: name, PasswordHash: hash, CreatedAt: time.Now()}
	m.users = append(m.users, u)
	w := Workspace{ID: int64(len(m.workspaces) + 1), Name: name + " 的空间", OwnerID: u.ID}
	m.workspaces = append(m.workspaces, w)
	m.members[u.ID] = append(m.members[u.ID], w.ID)
	return u, w, nil
}

func (m *Memory) UserByEmail(_ context.Context, email string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if strings.EqualFold(u.Email, email) {
			return u, nil
		}
	}
	return User{}, ErrNotFound
}

func (m *Memory) CreateSession(_ context.Context, h []byte, uid int64, exp time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[string(h)] = session{uid, exp}
	return nil
}

func (m *Memory) SessionUser(_ context.Context, h []byte, now time.Time) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[string(h)]
	if !ok || !now.Before(s.expires) {
		return User{}, ErrNotFound
	}
	return m.users[s.userID-1], nil
}

func (m *Memory) DeleteSession(_ context.Context, h []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, string(h))
	return nil
}

func (m *Memory) Workspaces(_ context.Context, uid int64) ([]Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Workspace{}
	for _, id := range m.members[uid] {
		out = append(out, m.workspaces[id-1])
	}
	return out, nil
}

func (m *Memory) Ping(context.Context) error { return nil }
