package canvasmodel

// FromSnapshot validates a detached snapshot before admitting it. It never
// repairs malformed data or discards tombstones; callers can retain the
// original bytes if validation fails. Wire format/versioning and durable
// migrations are deliberately outside this in-memory package.
func FromSnapshot(in Snapshot) (*Document, error) {
	if in.Revision > maxVersion || len(in.Nodes)+len(in.Edges)+len(in.Pages)+len(in.Elements) > maxObjects {
		return nil, ErrLimit
	}
	s := state{kind: in.Kind, root: in.RootID, rev: in.Revision, n: map[string]Node{}, e: map[string]Edge{}, p: map[string]Page{}, l: map[string]Element{}}
	switch in.Kind {
	case MindMap:
		if !validID(in.RootID) || len(in.Edges)+len(in.Pages)+len(in.Elements) != 0 {
			return nil, ErrInvalid
		}
	case Flowchart:
		if in.RootID != "" || len(in.Pages)+len(in.Elements) != 0 {
			return nil, ErrInvalid
		}
	case Slides:
		if in.RootID != "" || len(in.Nodes)+len(in.Edges) != 0 {
			return nil, ErrInvalid
		}
	default:
		return nil, ErrInvalid
	}
	for _, v := range in.Nodes {
		if !validVersion(v.Version, v.Deleted) || !s.validNode(v) {
			return nil, ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return nil, err
		}
		s.n[v.ID] = v
	}
	for _, v := range in.Edges {
		if !validVersion(v.Version, v.Deleted) || !validEdge(v) {
			return nil, ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return nil, err
		}
		s.e[v.ID] = v
	}
	for _, v := range in.Pages {
		if !validVersion(v.Version, v.Deleted) || !validPage(v) {
			return nil, ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return nil, err
		}
		s.p[v.ID] = v
	}
	for _, v := range in.Elements {
		if !validVersion(v.Version, v.Deleted) || !validElement(v) {
			return nil, ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return nil, err
		}
		s.l[v.ID] = v
	}
	if in.Kind == MindMap {
		root, ok := s.n[in.RootID]
		if !ok || root.Deleted || root.Parent != "" {
			return nil, ErrInvalid
		}
		for _, v := range s.n {
			if v.ID == in.RootID {
				continue
			}
			parent, ok := s.n[v.Parent]
			if !ok || v.Parent == v.ID || (!v.Deleted && parent.Deleted) {
				return nil, ErrInvalid
			}
			if !v.Deleted && s.nodeCycle(v.ID, v.Parent) {
				return nil, ErrInvalid
			}
		}
	}
	for _, v := range s.e {
		from, fromOK := s.n[v.From]
		to, toOK := s.n[v.To]
		if !fromOK || !toOK || (!v.Deleted && (from.Deleted || to.Deleted)) {
			return nil, ErrInvalid
		}
	}
	for _, v := range s.l {
		p, ok := s.p[v.PageID]
		if !ok || (!v.Deleted && p.Deleted) {
			return nil, ErrInvalid
		}
	}
	return &Document{s: s}, nil
}

func validVersion(v uint64, deleted bool) bool {
	return v > 0 && v <= maxVersion && (!deleted || v >= 2)
}
