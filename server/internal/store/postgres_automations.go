package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const automationCols = `id, base_id, name, enabled, trigger_kind, config, last_fired_at`

func (p *Postgres) Automations(ctx context.Context, base int64) ([]Automation, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+automationCols+` FROM bt_automations WHERE base_id=$1 ORDER BY id`, base)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (a Automation, err error) {
		err = r.Scan(&a.ID, &a.BaseID, &a.Name, &a.Enabled, &a.TriggerKind, &a.Config, &a.LastFiredAt)
		return
	})
}

func (p *Postgres) AllAutomations(ctx context.Context) ([]Automation, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+automationCols+` FROM bt_automations WHERE enabled ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (a Automation, err error) {
		err = r.Scan(&a.ID, &a.BaseID, &a.Name, &a.Enabled, &a.TriggerKind, &a.Config, &a.LastFiredAt)
		return
	})
}

func (p *Postgres) MarkFired(ctx context.Context, id int64, at time.Time) error {
	_, err := p.Pool.Exec(ctx, `UPDATE bt_automations SET last_fired_at=$2 WHERE id=$1`, id, at)
	return err
}

func (p *Postgres) AddAutomation(ctx context.Context, a Automation) (Automation, error) {
	if a.Config == nil {
		a.Config = []byte("{}")
	}
	err := p.Pool.QueryRow(ctx, `INSERT INTO bt_automations (base_id, name, enabled, trigger_kind, config)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`, a.BaseID, a.Name, a.Enabled, a.TriggerKind, a.Config).Scan(&a.ID)
	return a, err
}

func (p *Postgres) UpdateAutomation(ctx context.Context, a Automation) (Automation, error) {
	err := p.Pool.QueryRow(ctx, `UPDATE bt_automations SET name=$3, enabled=$4, trigger_kind=$5,
		config = CASE WHEN $6::jsonb IS NULL THEN config ELSE $6::jsonb END
		WHERE id=$1 AND base_id=$2 RETURNING config`,
		a.ID, a.BaseID, a.Name, a.Enabled, a.TriggerKind, rawJSON(a.Config)).Scan(&a.Config)
	return a, notFound(err)
}

func (p *Postgres) DeleteAutomation(ctx context.Context, base, id int64) error {
	t, err := p.Pool.Exec(ctx, `DELETE FROM bt_automations WHERE id=$1 AND base_id=$2`, id, base)
	if err == nil && t.RowsAffected() == 0 {
		err = ErrNotFound
	}
	return err
}
