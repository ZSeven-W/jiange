package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// SurveySkipRule defines conditional branching when a respondent selects a specific option.
type SurveySkipRule struct {
	WhenOption       string `json:"whenOption"`
	JumpToQuestionID string `json:"jumpToQuestionId"` // target question id or "__END__"
}

// SurveyQuestion represents one question inside a standalone questionnaire.
type SurveyQuestion struct {
	ID          string           `json:"id"`
	Type        string           `json:"type"` // single | multi | text | rating | matrix | ranking | signature | file
	Title       string           `json:"title"`
	Description string           `json:"description,omitempty"`
	Required    bool             `json:"required"`
	Options     []string         `json:"options,omitempty"`
	MatrixRows  []string         `json:"matrixRows,omitempty"`
	MatrixCols  []string         `json:"matrixCols,omitempty"`
	MaxRating   int              `json:"maxRating,omitempty"`
	SkipRules   []SurveySkipRule `json:"skipRules,omitempty"`
}

// Survey holds metadata, publishing state, and question schema for a `kind="survey"` node.
type Survey struct {
	NodeID         int64            `json:"nodeId"`
	Description    string           `json:"description"`
	Status         string           `json:"status"` // draft | published | closed
	PublicToken    string           `json:"publicToken,omitempty"`
	AllowAnonymous bool             `json:"allowAnonymous"`
	MaxResponses   int              `json:"maxResponses"`
	Questions      []SurveyQuestion `json:"questions"`
	Revision       int64            `json:"revision"`
	PublishedAt    *time.Time       `json:"publishedAt,omitempty"`
	ClosedAt       *time.Time       `json:"closedAt,omitempty"`
	UpdatedAt      time.Time        `json:"updatedAt"`
}

// SurveyUpdate carries editable survey fields with optimistic revision check.
type SurveyUpdate struct {
	Description      string
	Questions        []SurveyQuestion
	AllowAnonymous   *bool
	MaxResponses     *int
	ExpectedRevision int64
}

// SurveyResponse stores one submitted questionnaire response.
type SurveyResponse struct {
	ID             int64           `json:"id"`
	SurveyID       int64           `json:"surveyId"`
	RespondentID   *int64          `json:"respondentId,omitempty"`
	RespondentName string          `json:"respondentName"`
	Answers        json.RawMessage `json:"answers"`
	SubmittedAt    time.Time       `json:"submittedAt"`
}

// SurveyStore persists standalone surveys and responses.
type SurveyStore interface {
	GetSurvey(ctx context.Context, nodeID int64) (Survey, error)
	GetSurveyByToken(ctx context.Context, token string) (Survey, DocMeta, error)
	SaveSurvey(ctx context.Context, nodeID int64, patch SurveyUpdate) (Survey, error)
	SetSurveyStatus(ctx context.Context, nodeID int64, status string, allowAnonymous *bool, maxResponses *int) (Survey, error)
	SubmitSurveyResponse(ctx context.Context, surveyID int64, respondentID *int64, respondentName string, answers json.RawMessage) (SurveyResponse, error)
	ListSurveyResponses(ctx context.Context, surveyID int64) ([]SurveyResponse, error)
}

func defaultSurveyQuestions() []SurveyQuestion {
	return []SurveyQuestion{
		{
			ID:       "q1",
			Type:     "single",
			Title:    "您对本次产品体验的总体评价是？",
			Required: true,
			Options:  []string{"非常满意", "比较满意", "一般", "有待改进"},
		},
		{
			ID:       "q2",
			Type:     "text",
			Title:    "欢迎留下您的具体建议或反馈",
			Required: false,
		},
	}
}

func newSurveyToken() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return "sv_" + hex.EncodeToString(b[:])
}

func cloneSurvey(s Survey) Survey {
	cp := s
	if s.Questions != nil {
		b, _ := json.Marshal(s.Questions)
		var q []SurveyQuestion
		_ = json.Unmarshal(b, &q)
		cp.Questions = q
	}
	return cp
}

func (m *Memory) initSurveyLocked(nodeID int64) {
	if m.surveys == nil {
		m.surveys = map[int64]Survey{}
	}
	if _, ok := m.surveys[nodeID]; !ok {
		m.surveys[nodeID] = Survey{
			NodeID:         nodeID,
			Description:    "感谢参与本次问卷调研，您的反馈对我们非常重要。",
			Status:         "draft",
			AllowAnonymous: true,
			MaxResponses:   0,
			Questions:      defaultSurveyQuestions(),
			Revision:       1,
			UpdatedAt:      time.Now(),
		}
	}
}

func (m *Memory) GetSurvey(_ context.Context, nodeID int64) (Survey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "survey" {
		return Survey{}, ErrNotFound
	}
	m.initSurveyLocked(nodeID)
	return cloneSurvey(m.surveys[nodeID]), nil
}

func (m *Memory) GetSurveyByToken(_ context.Context, token string) (Survey, DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for nodeID, s := range m.surveys {
		if s.PublicToken == token && token != "" {
			d := m.doc(nodeID)
			if d == nil || d.deleted || d.purged || d.meta.Kind != "survey" {
				return Survey{}, DocMeta{}, ErrNotFound
			}
			return cloneSurvey(s), d.meta, nil
		}
	}
	return Survey{}, DocMeta{}, ErrNotFound
}

func (m *Memory) SaveSurvey(_ context.Context, nodeID int64, patch SurveyUpdate) (Survey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "survey" {
		return Survey{}, ErrNotFound
	}
	m.initSurveyLocked(nodeID)
	s := m.surveys[nodeID]
	if patch.ExpectedRevision > 0 && s.Revision != patch.ExpectedRevision {
		return Survey{}, ErrConflict
	}
	s.Description = patch.Description
	s.Questions = patch.Questions
	if patch.AllowAnonymous != nil {
		s.AllowAnonymous = *patch.AllowAnonymous
	}
	if patch.MaxResponses != nil && *patch.MaxResponses >= 0 {
		s.MaxResponses = *patch.MaxResponses
	}
	s.Revision++
	s.UpdatedAt = time.Now()
	d.meta.UpdatedAt = s.UpdatedAt
	m.surveys[nodeID] = s
	return cloneSurvey(s), nil
}

func (m *Memory) SetSurveyStatus(_ context.Context, nodeID int64, status string, allowAnonymous *bool, maxResponses *int) (Survey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "survey" {
		return Survey{}, ErrNotFound
	}
	m.initSurveyLocked(nodeID)
	s := m.surveys[nodeID]
	now := time.Now()
	s.Status = status
	if status == "published" {
		if s.PublicToken == "" {
			s.PublicToken = newSurveyToken()
		}
		s.PublishedAt = &now
		s.ClosedAt = nil
	} else if status == "closed" {
		s.ClosedAt = &now
	}
	if allowAnonymous != nil {
		s.AllowAnonymous = *allowAnonymous
	}
	if maxResponses != nil && *maxResponses >= 0 {
		s.MaxResponses = *maxResponses
	}
	s.Revision++
	s.UpdatedAt = now
	m.surveys[nodeID] = s
	return cloneSurvey(s), nil
}

func (m *Memory) SubmitSurveyResponse(_ context.Context, surveyID int64, respondentID *int64, respondentName string, answers json.RawMessage) (SurveyResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.surveys[surveyID]
	if !ok {
		return SurveyResponse{}, ErrNotFound
	}
	if s.Status != "published" {
		return SurveyResponse{}, ErrConflict
	}
	if s.MaxResponses > 0 {
		count := 0
		for _, r := range m.surveyResponses {
			if r.SurveyID == surveyID {
				count++
			}
		}
		if count >= s.MaxResponses {
			return SurveyResponse{}, ErrConflict
		}
	}
	m.surveyRespSeq++
	resp := SurveyResponse{
		ID:             m.surveyRespSeq,
		SurveyID:       surveyID,
		RespondentID:   respondentID,
		RespondentName: respondentName,
		Answers:        append(json.RawMessage(nil), answers...),
		SubmittedAt:    time.Now(),
	}
	m.surveyResponses = append(m.surveyResponses, resp)
	return resp, nil
}

func (m *Memory) ListSurveyResponses(_ context.Context, surveyID int64) ([]SurveyResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SurveyResponse, 0)
	for i := len(m.surveyResponses) - 1; i >= 0; i-- {
		if m.surveyResponses[i].SurveyID == surveyID {
			cp := m.surveyResponses[i]
			cp.Answers = append(json.RawMessage(nil), cp.Answers...)
			out = append(out, cp)
		}
	}
	return out, nil
}

func (p *Postgres) initSurveyPG(ctx context.Context, tx pgx.Tx, nodeID int64) error {
	rawQ, err := json.Marshal(defaultSurveyQuestions())
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO surveys (node_id, description, status, allow_anonymous, max_responses, questions, revision)
		VALUES ($1, '感谢参与本次问卷调研，您的反馈对我们非常重要。', 'draft', true, 0, $2, 1)
		ON CONFLICT (node_id) DO NOTHING
	`, nodeID, rawQ)
	return err
}

func scanSurvey(row pgx.Row) (Survey, error) {
	var s Survey
	var rawQ []byte
	var token *string
	err := row.Scan(
		&s.NodeID, &s.Description, &s.Status, &token,
		&s.AllowAnonymous, &s.MaxResponses, &rawQ, &s.Revision,
		&s.PublishedAt, &s.ClosedAt, &s.UpdatedAt,
	)
	if err != nil {
		return Survey{}, err
	}
	if token != nil {
		s.PublicToken = *token
	}
	if len(rawQ) > 0 {
		_ = json.Unmarshal(rawQ, &s.Questions)
	}
	if s.Questions == nil {
		s.Questions = []SurveyQuestion{}
	}
	return s, nil
}

const surveySelectCols = `
	s.node_id, s.description, s.status, s.public_token,
	s.allow_anonymous, s.max_responses, s.questions, s.revision,
	s.published_at, s.closed_at, s.updated_at
`

func (p *Postgres) GetSurvey(ctx context.Context, nodeID int64) (Survey, error) {
	var kind string
	err := p.Pool.QueryRow(ctx, `SELECT kind FROM nodes WHERE id=$1 AND deleted_at IS NULL`, nodeID).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && kind != "survey") {
		return Survey{}, ErrNotFound
	}
	if err != nil {
		return Survey{}, err
	}
	row := p.Pool.QueryRow(ctx, `SELECT `+surveySelectCols+` FROM surveys s WHERE s.node_id=$1`, nodeID)
	s, err := scanSurvey(row)
	if errors.Is(err, pgx.ErrNoRows) {
		rawQ, _ := json.Marshal(defaultSurveyQuestions())
		row = p.Pool.QueryRow(ctx, `
			INSERT INTO surveys (node_id, description, status, allow_anonymous, max_responses, questions, revision)
			VALUES ($1, '感谢参与本次问卷调研，您的反馈对我们非常重要。', 'draft', true, 0, $2, 1)
			ON CONFLICT (node_id) DO UPDATE SET node_id = EXCLUDED.node_id
			RETURNING node_id, description, status, public_token, allow_anonymous, max_responses, questions, revision, published_at, closed_at, updated_at
		`, nodeID, rawQ)
		return scanSurvey(row)
	}
	return s, err
}

func (p *Postgres) GetSurveyByToken(ctx context.Context, token string) (Survey, DocMeta, error) {
	var s Survey
	var rawQ []byte
	var tok *string
	var meta DocMeta
	err := p.Pool.QueryRow(ctx, `
		SELECT `+surveySelectCols+`, n.id, n.workspace_id, n.kind, n.title, n.updated_at
		FROM surveys s
		JOIN nodes n ON n.id = s.node_id
		WHERE s.public_token = $1 AND n.deleted_at IS NULL AND n.kind = 'survey'
	`, token).Scan(
		&s.NodeID, &s.Description, &s.Status, &tok,
		&s.AllowAnonymous, &s.MaxResponses, &rawQ, &s.Revision,
		&s.PublishedAt, &s.ClosedAt, &s.UpdatedAt,
		&meta.ID, &meta.WorkspaceID, &meta.Kind, &meta.Title, &meta.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Survey{}, DocMeta{}, ErrNotFound
	}
	if err != nil {
		return Survey{}, DocMeta{}, err
	}
	if tok != nil {
		s.PublicToken = *tok
	}
	if len(rawQ) > 0 {
		_ = json.Unmarshal(rawQ, &s.Questions)
	}
	if s.Questions == nil {
		s.Questions = []SurveyQuestion{}
	}
	return s, meta, nil
}

func (p *Postgres) SaveSurvey(ctx context.Context, nodeID int64, patch SurveyUpdate) (Survey, error) {
	if _, err := p.GetSurvey(ctx, nodeID); err != nil {
		return Survey{}, err
	}
	rawQ, err := json.Marshal(patch.Questions)
	if err != nil {
		return Survey{}, err
	}
	var out Survey
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var cur Survey
		cur, err := scanSurvey(tx.QueryRow(ctx, `SELECT `+surveySelectCols+` FROM surveys s WHERE s.node_id=$1 FOR UPDATE`, nodeID))
		if err != nil {
			return err
		}
		if patch.ExpectedRevision > 0 && cur.Revision != patch.ExpectedRevision {
			return ErrConflict
		}
		allowAnon := cur.AllowAnonymous
		if patch.AllowAnonymous != nil {
			allowAnon = *patch.AllowAnonymous
		}
		maxResp := cur.MaxResponses
		if patch.MaxResponses != nil && *patch.MaxResponses >= 0 {
			maxResp = *patch.MaxResponses
		}
		out, err = scanSurvey(tx.QueryRow(ctx, `
			UPDATE surveys s
			SET description=$2, questions=$3, allow_anonymous=$4, max_responses=$5, revision=revision+1, updated_at=now()
			WHERE s.node_id=$1
			RETURNING `+surveySelectCols,
			nodeID, patch.Description, rawQ, allowAnon, maxResp,
		))
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, nodeID)
		return err
	})
	return out, err
}

func (p *Postgres) SetSurveyStatus(ctx context.Context, nodeID int64, status string, allowAnonymous *bool, maxResponses *int) (Survey, error) {
	if _, err := p.GetSurvey(ctx, nodeID); err != nil {
		return Survey{}, err
	}
	var out Survey
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		cur, err := scanSurvey(tx.QueryRow(ctx, `SELECT `+surveySelectCols+` FROM surveys s WHERE s.node_id=$1 FOR UPDATE`, nodeID))
		if err != nil {
			return err
		}
		tok := cur.PublicToken
		if status == "published" && tok == "" {
			tok = newSurveyToken()
		}
		var tokPtr *string
		if tok != "" {
			tokPtr = &tok
		}
		allowAnon := cur.AllowAnonymous
		if allowAnonymous != nil {
			allowAnon = *allowAnonymous
		}
		maxResp := cur.MaxResponses
		if maxResponses != nil && *maxResponses >= 0 {
			maxResp = *maxResponses
		}
		now := time.Now()
		pubAt := cur.PublishedAt
		closedAt := cur.ClosedAt
		if status == "published" {
			pubAt = &now
			closedAt = nil
		} else if status == "closed" {
			closedAt = &now
		}
		out, err = scanSurvey(tx.QueryRow(ctx, `
			UPDATE surveys s
			SET status=$2, public_token=$3, allow_anonymous=$4, max_responses=$5, published_at=$6, closed_at=$7, revision=revision+1, updated_at=now()
			WHERE s.node_id=$1
			RETURNING `+surveySelectCols,
			nodeID, status, tokPtr, allowAnon, maxResp, pubAt, closedAt,
		))
		return err
	})
	return out, err
}

func (p *Postgres) SubmitSurveyResponse(ctx context.Context, surveyID int64, respondentID *int64, respondentName string, answers json.RawMessage) (SurveyResponse, error) {
	var out SurveyResponse
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var status string
		var maxResp int
		if err := tx.QueryRow(ctx, `SELECT status, max_responses FROM surveys WHERE node_id=$1 FOR UPDATE`, surveyID).Scan(&status, &maxResp); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if status != "published" {
			return ErrConflict
		}
		if maxResp > 0 {
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM survey_responses WHERE survey_id=$1`, surveyID).Scan(&count); err != nil {
				return err
			}
			if count >= maxResp {
				return ErrConflict
			}
		}
		var rawAns []byte
		err := tx.QueryRow(ctx, `
			INSERT INTO survey_responses (survey_id, respondent_id, respondent_name, answers)
			VALUES ($1, $2, $3, $4)
			RETURNING id, survey_id, respondent_id, respondent_name, answers, submitted_at
		`, surveyID, respondentID, respondentName, []byte(answers)).Scan(
			&out.ID, &out.SurveyID, &out.RespondentID, &out.RespondentName, &rawAns, &out.SubmittedAt,
		)
		if err != nil {
			return err
		}
		out.Answers = rawAns
		return nil
	})
	return out, err
}

func (p *Postgres) ListSurveyResponses(ctx context.Context, surveyID int64) ([]SurveyResponse, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, survey_id, respondent_id, respondent_name, answers, submitted_at
		FROM survey_responses
		WHERE survey_id = $1
		ORDER BY submitted_at DESC, id DESC
	`, surveyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SurveyResponse, 0)
	for rows.Next() {
		var r SurveyResponse
		var rawAns []byte
		if err := rows.Scan(&r.ID, &r.SurveyID, &r.RespondentID, &r.RespondentName, &rawAns, &r.SubmittedAt); err != nil {
			return nil, err
		}
		r.Answers = rawAns
		out = append(out, r)
	}
	return out, rows.Err()
}
