package collab

// TryTransaction journals the mutations made by TryApply so a caller can
// validate a batch before its persistence transaction has committed. It is
// proportional to the changed data, rather than copying the whole document.
// The document must not be used by another goroutine until the transaction
// has been committed or rolled back.
type TryTransaction struct {
	doc    *Doc
	undo   []func()
	closed bool
}

// BeginTryTransaction starts a reversible sequence of immediately applicable
// operations. Apply (which may buffer pending operations) is not supported
// during a transaction.
func (d *Doc) BeginTryTransaction() *TryTransaction { return &TryTransaction{doc: d} }

// TryApply integrates an operation and records its previous state. On a
// validation error it does not add to the journal or change the document.
func (tx *TryTransaction) TryApply(op Op) error {
	if tx.closed {
		panic("collab: transaction already closed")
	}
	d := tx.doc
	if err := d.validateTryApply(op); err != nil {
		return err
	}
	oldClock := d.clock
	var undoMutation func()
	switch op.T {
	case TBlockCreate:
		undoMutation = func() { delete(d.blocks, op.ID); d.unoccupy(op.ID) }
	case TBlockMove:
		b := d.blocks[op.Block]
		parent, pos, ts := b.parent, b.pos, b.locTS
		undoMutation = func() { b.parent, b.pos, b.locTS = parent, pos, ts }
	case TBlockSet:
		b := d.blocks[op.Block]
		old, present := b.props[op.Key]
		undoMutation = func() {
			if present {
				b.props[op.Key] = old
			} else {
				delete(b.props, op.Key)
			}
		}
	case TBlockDelete:
		b := d.blocks[op.Block]
		old := b.deleted
		undoMutation = func() { b.deleted = old }
	case TTextInsert:
		b := d.blocks[op.Block]
		oldOrder := b.order
		parent := b.chars[op.Parent]
		span := op.Span()
		undoMutation = func() {
			if span > 0 {
				first := b.chars[op.ID]
				if op.Side == 0 {
					parent.left = removeNode(parent.left, first)
				} else {
					parent.right = removeNode(parent.right, first)
				}
				for i := uint64(0); i < span; i++ {
					id := OpID{op.ID.Client, op.ID.Clock + i}
					delete(b.chars, id)
					d.unoccupy(id)
				}
			}
			b.order = oldOrder
		}
	case TTextDelete:
		b := d.blocks[op.Block]
		oldOrder := b.order
		oldDeleted := make([]bool, op.Len)
		for i := uint64(0); i < op.Len; i++ {
			oldDeleted[i] = b.chars[OpID{op.Target.Client, op.Target.Clock + i}].deleted
		}
		undoMutation = func() {
			for i := uint64(0); i < op.Len; i++ {
				b.chars[OpID{op.Target.Client, op.Target.Clock + i}].deleted = oldDeleted[i]
			}
			b.order = oldOrder
		}
	case TMark:
		b := d.blocks[op.Block]
		oldLen := len(b.marks)
		undoMutation = func() { b.marks = b.marks[:oldLen] }
	default:
		// validateTryApply accepts only operations decoded by the protocol in
		// server use; unknown operations still update the identity and clock.
		undoMutation = func() {}
	}
	d.integrate(&op)
	tx.undo = append(tx.undo, func() {
		undoMutation()
		delete(d.seen, op.ID)
		d.clock = oldClock
	})
	return nil
}

// Rollback reverses all successful operations in reverse dependency order.
func (tx *TryTransaction) Rollback() {
	if tx.closed {
		return
	}
	for i := len(tx.undo) - 1; i >= 0; i-- {
		tx.undo[i]()
	}
	tx.undo = nil
	tx.closed = true
}

// Commit keeps the integrated operations and discards the journal.
func (tx *TryTransaction) Commit() {
	if tx.closed {
		return
	}
	tx.undo = nil
	tx.closed = true
}
