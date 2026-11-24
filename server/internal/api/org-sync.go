package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const maxOrgSyncBodyBytes = 4 << 20 // 4 MiB for large enterprise directories

func (s *Server) listOrgSyncState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	sources, runs, err := s.Store.ListOrgSyncState(r.Context(), guard, wsID)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	sources, err = s.Store.EnrichOrgSyncSources(r.Context(), wsID, sources)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"sources": sources,
		"runs":    runs,
	})
}

func (s *Server) createOrgSyncSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Name                string              `json:"name"`
		Provider            string              `json:"provider"`
		AutoInviteMissing   *bool               `json:"autoInviteMissing"`
		PruneMissing        bool                `json:"pruneMissing"`
		EndpointURL         string              `json:"endpointUrl"`
		ConnectorConfig     *OrgConnectorConfig `json:"connectorConfig"`
		SyncIntervalMinutes int                 `json:"syncIntervalMinutes"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "同步源名称不能为空")
		return
	}
	provider := strings.TrimSpace(strings.ToLower(in.Provider))
	if provider == "" {
		provider = store.OrgSyncProviderCustom
	}
	if !store.ValidOrgSyncProvider(provider) {
		httpx.Error(w, http.StatusBadRequest, "invalid_provider", "不支持的目录同步协议类型")
		return
	}
	if in.SyncIntervalMinutes < 0 || in.SyncIntervalMinutes > 10080 {
		httpx.Error(w, http.StatusBadRequest, "invalid_interval", "定时同步间隔需在 0 至 10080 分钟之间")
		return
	}

	opts := s.orgConnectorNetOpts()
	hasConnectorUpdate := strings.TrimSpace(in.EndpointURL) != "" || in.ConnectorConfig != nil || in.SyncIntervalMinutes > 0
	var validatedCfg OrgConnectorConfig
	var resolvedEndpoint string
	if in.ConnectorConfig != nil {
		var err error
		validatedCfg, resolvedEndpoint, err = mergeAndValidateConnectorConfig(provider, in.EndpointURL, *in.ConnectorConfig, nil, opts)
		if err != nil {
			if errors.Is(err, errBlockedAddress) {
				httpx.Error(w, http.StatusBadRequest, "blocked_address", "连接器地址被安全策略拦截")
				return
			}
			httpx.Error(w, http.StatusBadRequest, "invalid_connector_config", err.Error())
			return
		}
	} else if strings.TrimSpace(in.EndpointURL) != "" {
		var err error
		resolvedEndpoint, err = validateOrgConnectorEndpoint(provider, in.EndpointURL, opts)
		if err != nil {
			if errors.Is(err, errBlockedAddress) {
				httpx.Error(w, http.StatusBadRequest, "blocked_address", "连接器地址被安全策略拦截")
				return
			}
			httpx.Error(w, http.StatusBadRequest, "invalid_endpoint_url", err.Error())
			return
		}
	}

	autoInvite := true
	if in.AutoInviteMissing != nil {
		autoInvite = *in.AutoInviteMissing
	}
	created, err := s.Store.CreateOrgSyncSourceGuarded(r.Context(), guard, wsID, in.Name, provider, autoInvite, in.PruneMissing)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	if hasConnectorUpdate {
		var configEnc []byte
		var configHint string
		if in.ConnectorConfig != nil {
			configEnc, err = sealOrgConnectorConfig(s.orgConnectorSecretKey(), wsID, created.Source.ID, validatedCfg)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			configHint = orgConnectorConfigHint(provider, validatedCfg)
		}
		updatedSrc, err := s.Store.UpdateOrgSyncConnector(r.Context(), guard, wsID, created.Source.ID, resolvedEndpoint, configEnc, configHint, in.SyncIntervalMinutes)
		if err != nil {
			s.orgError(w, r, err)
			return
		}
		created.Source = updatedSrc
	}
	httpx.JSON(w, http.StatusCreated, created)
}

func (s *Server) updateOrgSyncSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	sourceID, ok := s.parsePositivePathID(w, r, "sourceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Name                *string             `json:"name"`
		Enabled             *bool               `json:"enabled"`
		AutoInviteMissing   *bool               `json:"autoInviteMissing"`
		PruneMissing        *bool               `json:"pruneMissing"`
		RotateToken         bool                `json:"rotateToken"`
		EndpointURL         *string             `json:"endpointUrl"`
		ConnectorConfig     *OrgConnectorConfig `json:"connectorConfig"`
		SyncIntervalMinutes *int                `json:"syncIntervalMinutes"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "同步源名称不能为空")
		return
	}
	if in.SyncIntervalMinutes != nil && (*in.SyncIntervalMinutes < 0 || *in.SyncIntervalMinutes > 10080) {
		httpx.Error(w, http.StatusBadRequest, "invalid_interval", "定时同步间隔需在 0 至 10080 分钟之间")
		return
	}
	updated, err := s.Store.UpdateOrgSyncSourceGuarded(r.Context(), guard, wsID, sourceID, store.OrgSyncSourcePatch{
		Name:              in.Name,
		Enabled:           in.Enabled,
		AutoInviteMissing: in.AutoInviteMissing,
		PruneMissing:      in.PruneMissing,
		RotateToken:       in.RotateToken,
	})
	if err != nil {
		s.orgError(w, r, err)
		return
	}

	if in.EndpointURL != nil || in.ConnectorConfig != nil || in.SyncIntervalMinutes != nil {
		cur, err := s.Store.GetOrgSyncSourceSystem(r.Context(), sourceID)
		if err != nil {
			s.orgError(w, r, err)
			return
		}
		opts := s.orgConnectorNetOpts()
		endpointURL := cur.EndpointURL
		if in.EndpointURL != nil {
			endpointURL = strings.TrimSpace(*in.EndpointURL)
		}
		intervalMinutes := cur.SyncIntervalMinutes
		if in.SyncIntervalMinutes != nil {
			intervalMinutes = *in.SyncIntervalMinutes
		}

		var configEnc []byte
		var configHint string
		if in.ConnectorConfig != nil {
			var existingCfg *OrgConnectorConfig
			if len(cur.ConnectorConfigEnc) > 0 {
				if opened, openErr := openOrgConnectorConfig(s.orgConnectorSecretKey(), wsID, sourceID, cur.ConnectorConfigEnc); openErr == nil {
					existingCfg = &opened
				}
			}
			mergedCfg, resolvedEp, err := mergeAndValidateConnectorConfig(updated.Source.Provider, endpointURL, *in.ConnectorConfig, existingCfg, opts)
			if err != nil {
				if errors.Is(err, errBlockedAddress) {
					httpx.Error(w, http.StatusBadRequest, "blocked_address", "连接器地址被安全策略拦截")
					return
				}
				httpx.Error(w, http.StatusBadRequest, "invalid_connector_config", err.Error())
				return
			}
			endpointURL = resolvedEp
			configEnc, err = sealOrgConnectorConfig(s.orgConnectorSecretKey(), wsID, sourceID, mergedCfg)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			configHint = orgConnectorConfigHint(updated.Source.Provider, mergedCfg)
		} else if in.EndpointURL != nil && endpointURL != "" {
			resolvedEp, err := validateOrgConnectorEndpoint(updated.Source.Provider, endpointURL, opts)
			if err != nil {
				if errors.Is(err, errBlockedAddress) {
					httpx.Error(w, http.StatusBadRequest, "blocked_address", "连接器地址被安全策略拦截")
					return
				}
				httpx.Error(w, http.StatusBadRequest, "invalid_endpoint_url", err.Error())
				return
			}
			endpointURL = resolvedEp
		}

		updatedSrc, err := s.Store.UpdateOrgSyncConnector(r.Context(), guard, wsID, sourceID, endpointURL, configEnc, configHint, intervalMinutes)
		if err != nil {
			s.orgError(w, r, err)
			return
		}
		updated.Source = updatedSrc
	} else {
		enriched, err := s.Store.EnrichOrgSyncSources(r.Context(), wsID, []store.OrgSyncSource{updated.Source})
		if err == nil && len(enriched) == 1 {
			updated.Source = enriched[0]
		}
	}
	httpx.JSON(w, http.StatusOK, updated)
}

func (s *Server) deleteOrgSyncSource(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	sourceID, ok := s.parsePositivePathID(w, r, "sourceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	if err := s.Store.DeleteOrgSyncSourceGuarded(r.Context(), guard, wsID, sourceID); err != nil {
		s.orgError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) runOrgDirectorySync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	sourceID, ok := s.parsePositivePathID(w, r, "sourceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	payload, _, ok := decodeOrgSyncPayload(w, r)
	if !ok {
		return
	}
	run, err := s.Store.RunOrgDirectorySyncGuarded(r.Context(), guard, wsID, sourceID, payload)
	if err != nil {
		if errors.Is(err, store.ErrConflict) && run.ErrorMessage != "" {
			httpx.Error(w, http.StatusConflict, "invalid_payload", run.ErrorMessage)
			return
		}
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, run)
}

func (s *Server) pushOrgDirectorySync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	rawToken, ok := parseBearerToken(r.Header.Get("Authorization"))
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "缺少有效的目录同步 Bearer Token")
		return
	}
	payload, isSCIM, ok := decodeOrgSyncPayload(w, r)
	if !ok {
		return
	}
	triggerMode := store.OrgSyncTriggerPush
	if isSCIM {
		triggerMode = store.OrgSyncTriggerSCIM
	}
	run, err := s.Store.PushOrgDirectorySyncByToken(r.Context(), store.HashOrgSyncToken(rawToken), triggerMode, payload)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrUnauthenticated):
			httpx.Error(w, http.StatusUnauthorized, "invalid_token", "目录同步 Token 无效")
		case errors.Is(err, store.ErrForbidden):
			httpx.Error(w, http.StatusForbidden, "source_disabled", "该目录同步源已停用")
		case errors.Is(err, store.ErrConflict):
			msg := run.ErrorMessage
			if msg == "" {
				msg = "目录同步数据校验失败"
			}
			httpx.Error(w, http.StatusConflict, "invalid_payload", msg)
		default:
			s.fail(w, r, err)
		}
		return
	}
	httpx.JSON(w, http.StatusOK, run)
}

func parseBearerToken(header string) (string, bool) {
	header = strings.TrimSpace(header)
	if len(header) < 8 || !strings.EqualFold(header[:7], "Bearer ") {
		return "", false
	}
	tok := strings.TrimSpace(header[7:])
	return tok, tok != ""
}

// decodeOrgSyncPayload parses either Jiange's native OrgDirectorySyncPayload or
// a SCIM 2.0 ListResponse payload into a normalized OrgDirectorySyncPayload.
func decodeOrgSyncPayload(w http.ResponseWriter, r *http.Request) (store.OrgDirectorySyncPayload, bool, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxOrgSyncBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "请求体过大或无法读取")
		return store.OrgDirectorySyncPayload{}, false, false
	}
	var probe struct {
		Schemas   []string          `json:"schemas"`
		Resources []json.RawMessage `json:"Resources"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "无效的 JSON 格式")
		return store.OrgDirectorySyncPayload{}, false, false
	}
	if isSCIMEnvelope(probe.Schemas, probe.Resources) {
		p, err := normalizeSCIMPayload(raw)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_scim", err.Error())
			return store.OrgDirectorySyncPayload{}, true, false
		}
		return p, true, true
	}

	var payload store.OrgDirectorySyncPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "无效的目录同步 JSON 结构")
		return store.OrgDirectorySyncPayload{}, false, false
	}
	return payload, false, true
}

func isSCIMEnvelope(schemas []string, resources []json.RawMessage) bool {
	if len(resources) > 0 {
		return true
	}
	for _, s := range schemas {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(s)), "urn:ietf:params:scim:") {
			return true
		}
	}
	return false
}

type scimEnvelope struct {
	Schemas      []string          `json:"schemas"`
	Resources    []json.RawMessage `json:"Resources"`
	DryRun       bool              `json:"dryRun"`
	PruneMissing *bool             `json:"pruneMissing"`
}

type scimEmail struct {
	Value   string `json:"value"`
	Primary bool   `json:"primary"`
}

type scimRef struct {
	Value   string `json:"value"`
	Display string `json:"display"`
	Email   string `json:"email"`
}

type scimName struct {
	Formatted  string `json:"formatted"`
	GivenName  string `json:"givenName"`
	FamilyName string `json:"familyName"`
}

type scimEnterpriseExt struct {
	Department string `json:"department"`
	Division   string `json:"division"`
}

type scimResource struct {
	Schemas     []string           `json:"schemas"`
	ID          string             `json:"id"`
	ExternalID  string             `json:"externalId"`
	UserName    string             `json:"userName"`
	DisplayName string             `json:"displayName"`
	Name        *scimName          `json:"name"`
	Active      *bool              `json:"active"`
	Emails      []scimEmail        `json:"emails"`
	Groups      []scimRef          `json:"groups"`
	Members     []scimRef          `json:"members"`
	Enterprise  *scimEnterpriseExt `json:"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"`
}

func normalizeSCIMPayload(raw []byte) (store.OrgDirectorySyncPayload, error) {
	var env scimEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	out := store.OrgDirectorySyncPayload{
		DryRun:       env.DryRun,
		PruneMissing: env.PruneMissing,
	}
	deptSeen := map[string]bool{}
	groupSeen := map[string]bool{}
	ensureDeptPath := func(path string) string {
		parts := strings.Split(path, "/")
		var clean []string
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" {
				clean = append(clean, p)
			}
		}
		if len(clean) == 0 {
			return ""
		}
		parentExt := ""
		curExt := ""
		for i, seg := range clean {
			curExt = "dept:" + strings.Join(clean[:i+1], "/")
			if !deptSeen[curExt] {
				deptSeen[curExt] = true
				out.Departments = append(out.Departments, store.OrgSyncDeptInput{
					ExternalID:       curExt,
					ParentExternalID: parentExt,
					Name:             seg,
				})
			}
			parentExt = curExt
		}
		return curExt
	}
	ensureGroup := func(extID, name string) string {
		extID = strings.TrimSpace(extID)
		name = strings.TrimSpace(name)
		if extID == "" {
			extID = "scim-grp:" + name
		}
		if name == "" {
			name = extID
		}
		if !groupSeen[extID] {
			groupSeen[extID] = true
			out.Groups = append(out.Groups, store.OrgSyncGroupInput{
				ExternalID: extID,
				Name:       name,
			})
		}
		return extID
	}

	userIDToEmail := map[string]string{}
	memberIndexByEmail := map[string]int{}
	var deferredGroupMembers []struct {
		groupExt string
		members  []scimRef
	}

	for _, resRaw := range env.Resources {
		var res scimResource
		if err := json.Unmarshal(resRaw, &res); err != nil {
			continue
		}
		isGroup := false
		for _, sc := range res.Schemas {
			if strings.Contains(strings.ToLower(sc), ":group") {
				isGroup = true
				break
			}
		}
		if !isGroup && len(res.Members) > 0 && res.UserName == "" && len(res.Emails) == 0 {
			isGroup = true
		}
		if isGroup {
			ext := strings.TrimSpace(res.ExternalID)
			if ext == "" {
				ext = strings.TrimSpace(res.ID)
			}
			gExt := ensureGroup(ext, res.DisplayName)
			if len(res.Members) > 0 {
				deferredGroupMembers = append(deferredGroupMembers, struct {
					groupExt string
					members  []scimRef
				}{groupExt: gExt, members: res.Members})
			}
			continue
		}

		// User resource
		if res.Active != nil && !*res.Active {
			continue
		}
		email := pickSCIMEmail(res)
		if email == "" {
			continue
		}
		name := strings.TrimSpace(res.DisplayName)
		if name == "" && res.Name != nil {
			if strings.TrimSpace(res.Name.Formatted) != "" {
				name = strings.TrimSpace(res.Name.Formatted)
			} else {
				name = strings.TrimSpace(strings.TrimSpace(res.Name.GivenName) + " " + strings.TrimSpace(res.Name.FamilyName))
			}
		}
		m := store.OrgSyncMemberInput{
			Email: email,
			Name:  name,
		}
		if res.Enterprise != nil {
			deptPath := strings.TrimSpace(res.Enterprise.Department)
			if res.Enterprise.Division != "" && deptPath != "" {
				deptPath = strings.TrimSpace(res.Enterprise.Division) + "/" + deptPath
			} else if deptPath == "" {
				deptPath = strings.TrimSpace(res.Enterprise.Division)
			}
			if leafExt := ensureDeptPath(deptPath); leafExt != "" {
				m.DepartmentExternalIDs = append(m.DepartmentExternalIDs, leafExt)
			}
		}
		for _, g := range res.Groups {
			if strings.TrimSpace(g.Value) == "" && strings.TrimSpace(g.Display) == "" {
				continue
			}
			gExt := ensureGroup(g.Value, g.Display)
			m.GroupExternalIDs = append(m.GroupExternalIDs, gExt)
		}

		emailKey := strings.ToLower(strings.TrimSpace(email))
		if id := strings.TrimSpace(res.ID); id != "" {
			userIDToEmail[id] = emailKey
		}
		if ext := strings.TrimSpace(res.ExternalID); ext != "" {
			userIDToEmail[ext] = emailKey
		}
		if idx, exists := memberIndexByEmail[emailKey]; exists {
			out.Members[idx].DepartmentExternalIDs = append(out.Members[idx].DepartmentExternalIDs, m.DepartmentExternalIDs...)
			out.Members[idx].GroupExternalIDs = append(out.Members[idx].GroupExternalIDs, m.GroupExternalIDs...)
		} else {
			memberIndexByEmail[emailKey] = len(out.Members)
			out.Members = append(out.Members, m)
		}
	}

	// Bind SCIM Group.members references to matched users.
	for _, gm := range deferredGroupMembers {
		for _, ref := range gm.members {
			emailKey := ""
			if e := strings.ToLower(strings.TrimSpace(ref.Email)); e != "" {
				emailKey = e
			} else if mapped, ok := userIDToEmail[strings.TrimSpace(ref.Value)]; ok {
				emailKey = mapped
			} else if strings.Contains(ref.Value, "@") {
				emailKey = strings.ToLower(strings.TrimSpace(ref.Value))
			}
			if emailKey == "" {
				continue
			}
			if idx, ok := memberIndexByEmail[emailKey]; ok {
				out.Members[idx].GroupExternalIDs = append(out.Members[idx].GroupExternalIDs, gm.groupExt)
			}
		}
	}

	return out, nil
}

func pickSCIMEmail(res scimResource) string {
	for _, e := range res.Emails {
		if e.Primary && strings.Contains(e.Value, "@") {
			return strings.TrimSpace(e.Value)
		}
	}
	for _, e := range res.Emails {
		if strings.Contains(e.Value, "@") {
			return strings.TrimSpace(e.Value)
		}
	}
	if strings.Contains(res.UserName, "@") {
		return strings.TrimSpace(res.UserName)
	}
	return ""
}
