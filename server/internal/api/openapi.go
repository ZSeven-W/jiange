package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

var (
	openAPISpecOnce  sync.Once
	openAPISpecBytes []byte
	oaPathVarRE      = regexp.MustCompile(`\{([^}]+)\}`)
)

type oaProp struct {
	Type        string
	Description string
	Example     any
	Enum        []string
	ItemsType   string
	ItemsRef    string
	Ref         string
	Format      string
}

type oaResp struct {
	Desc        string
	Schema      map[string]any
	ContentType string
}

type oaRoute struct {
	Method  string
	Path    string
	Tag     string
	OpID    string
	Summary string
	Desc    string
	Params  []map[string]any
	Body    map[string]any
	Resps   map[string]oaResp
	Public  bool
}

var oaPathParamDescriptions = map[string]string{
	"wsId":       "Workspace ID",
	"id":         "Document or resource ID",
	"tid":        "Table, template, or token ID",
	"fid":        "Base field ID",
	"rid":        "Base record ID",
	"vid":        "View or version ID",
	"aid":        "Automation rule ID",
	"did":        "Base dashboard ID",
	"cid":        "Comment or notification channel ID",
	"pid":        "Slide page or SSO provider ID",
	"sid":        "Suggestion, shortcut, or synced block ID",
	"uid":        "User ID",
	"gid":        "Group ID",
	"wid":        "Worksheet or webhook ID",
	"deptId":     "Department ID",
	"groupId":    "User group ID",
	"inviteId":   "Workspace invitation ID",
	"sourceId":   "Directory sync source ID",
	"spaceId":    "Wiki space ID",
	"slug":       "SSO provider slug",
	"token":      "Public share or form token",
	"seq":        "Document version sequence number",
	"entry":      "Saved version entry ID",
	"requestId":  "Conditional operation request ID",
	"mutationId": "Idempotency mutation ID",
	"schemaId":   "SCIM 2.0 Schema URN",
	"typeId":     "SCIM 2.0 ResourceType identifier",
}

func oaRef(name string) map[string]any {
	return map[string]any{"$ref": "#/components/schemas/" + name}
}

func oaArrayRef(name string) map[string]any {
	return map[string]any{"type": "array", "items": oaRef(name)}
}

func oaPathParam(name, desc string) map[string]any {
	return map[string]any{
		"name":        name,
		"in":          "path",
		"required":    true,
		"description": desc,
		"schema":      map[string]any{"type": "string"},
	}
}

func oaQueryParam(name, schemaType, desc string, required bool) map[string]any {
	return map[string]any{
		"name":        name,
		"in":          "query",
		"required":    required,
		"description": desc,
		"schema":      map[string]any{"type": schemaType},
	}
}

func oaObjSchema(props map[string]oaProp, required ...string) map[string]any {
	properties := make(map[string]any, len(props))
	for k, p := range props {
		if p.Ref != "" {
			field := map[string]any{"$ref": "#/components/schemas/" + p.Ref}
			if p.Description != "" {
				field["description"] = p.Description
			}
			properties[k] = field
			continue
		}
		field := map[string]any{"type": p.Type}
		if p.Format != "" {
			field["format"] = p.Format
		}
		if p.Description != "" {
			field["description"] = p.Description
		}
		if p.Example != nil {
			field["example"] = p.Example
		}
		if len(p.Enum) > 0 {
			field["enum"] = p.Enum
		}
		if p.Type == "array" {
			if p.ItemsRef != "" {
				field["items"] = oaRef(p.ItemsRef)
			} else if p.ItemsType != "" {
				field["items"] = map[string]any{"type": p.ItemsType}
			}
		}
		properties[k] = field
	}
	schema := map[string]any{
		"type":       "object",
		"properties": properties,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func oaBody(contentType string, schema map[string]any, desc string) map[string]any {
	return map[string]any{
		"required":    true,
		"description": desc,
		"content": map[string]any{
			contentType: map[string]any{
				"schema": schema,
			},
		},
	}
}

func oaJSONBody(schema map[string]any, desc string) map[string]any {
	return oaBody("application/json", schema, desc)
}

func oaSCIMBody(schema map[string]any, desc string) map[string]any {
	return oaBody(scimContentType, schema, desc)
}

func oaJSONResp(desc, schemaName string) oaResp {
	return oaResp{Desc: desc, Schema: oaRef(schemaName), ContentType: "application/json"}
}

func oaJSONArrayResp(desc, schemaName string) oaResp {
	return oaResp{Desc: desc, Schema: oaArrayRef(schemaName), ContentType: "application/json"}
}

func oaJSONInlineResp(desc string, schema map[string]any) oaResp {
	return oaResp{Desc: desc, Schema: schema, ContentType: "application/json"}
}

func oaSCIMResp(desc, schemaName string) oaResp {
	return oaResp{Desc: desc, Schema: oaRef(schemaName), ContentType: scimContentType}
}

func oaTextResp(desc, contentType string) oaResp {
	return oaResp{
		Desc:        desc,
		Schema:      map[string]any{"type": "string"},
		ContentType: contentType,
	}
}

func oaBinaryResp(desc string) oaResp {
	return oaResp{
		Desc:        desc,
		Schema:      map[string]any{"type": "string", "format": "binary"},
		ContentType: "application/octet-stream",
	}
}

func oaPlainResp(desc string) oaResp {
	return oaResp{Desc: desc}
}

func oaErrResp(desc string) oaResp {
	return oaJSONResp(desc, "ErrorResponse")
}

func oaSCIMErrResp(desc string) oaResp {
	return oaSCIMResp(desc, "SCIMError")
}

func oaStdResp(okCode, okDesc, schemaName string, isArray bool) map[string]oaResp {
	r := map[string]oaResp{
		"401": oaErrResp("Unauthorized"),
		"403": oaErrResp("Forbidden"),
	}
	switch {
	case schemaName == "":
		r[okCode] = oaPlainResp(okDesc)
	case isArray:
		r[okCode] = oaJSONArrayResp(okDesc, schemaName)
	default:
		r[okCode] = oaJSONResp(okDesc, schemaName)
	}
	return r
}

func oaBuildResponses(path string, resps map[string]oaResp) map[string]any {
	out := make(map[string]any, len(resps))
	isSCIM := strings.HasPrefix(path, "/scim/")
	for code, r := range resps {
		entry := map[string]any{"description": r.Desc}
		schema := r.Schema
		ct := r.ContentType
		if schema == nil && (strings.HasPrefix(code, "4") || strings.HasPrefix(code, "5")) {
			if isSCIM {
				schema = oaRef("SCIMError")
				ct = scimContentType
			} else {
				schema = oaRef("ErrorResponse")
				ct = "application/json"
			}
		}
		if schema != nil {
			if ct == "" {
				if isSCIM {
					ct = scimContentType
				} else {
					ct = "application/json"
				}
			}
			entry["content"] = map[string]any{
				ct: map[string]any{"schema": schema},
			}
		}
		out[code] = entry
	}
	return out
}

func oaRegisterRoutes(paths map[string]any, routes []oaRoute) {
	for _, rt := range routes {
		method := strings.ToLower(rt.Method)
		pathItem, ok := paths[rt.Path].(map[string]any)
		if !ok {
			pathItem = map[string]any{}
			paths[rt.Path] = pathItem
		}

		// Ensure every {param} in path has a corresponding "in": "path" parameter.
		seenPath := map[string]bool{}
		for _, p := range rt.Params {
			if p["in"] == "path" {
				if name, ok := p["name"].(string); ok {
					seenPath[name] = true
				}
			}
		}
		var params []map[string]any
		for _, m := range oaPathVarRE.FindAllStringSubmatch(rt.Path, -1) {
			name := m[1]
			if !seenPath[name] {
				desc := oaPathParamDescriptions[name]
				if desc == "" {
					desc = "Resource identifier (" + name + ")"
				}
				params = append(params, oaPathParam(name, desc))
				seenPath[name] = true
			}
		}
		params = append(params, rt.Params...)

		op := map[string]any{
			"tags":        []string{rt.Tag},
			"operationId": rt.OpID,
			"summary":     rt.Summary,
			"description": rt.Desc,
			"responses":   oaBuildResponses(rt.Path, rt.Resps),
		}
		if len(params) > 0 {
			op["parameters"] = params
		}
		if rt.Body != nil {
			op["requestBody"] = rt.Body
		}
		if rt.Public {
			op["security"] = []any{}
		}
		pathItem[method] = op
	}
}

func oaSchemas() map[string]any {
	return map[string]any{
		"ErrorResponse": oaObjSchema(map[string]oaProp{
			"error":   {Type: "string", Description: "Machine-readable error code", Example: "forbidden"},
			"message": {Type: "string", Description: "Human-readable error detail", Example: "Insufficient permissions"},
		}, "error", "message"),
		"HealthResponse": oaObjSchema(map[string]oaProp{
			"status": {Type: "string", Description: "Liveness status", Enum: []string{"ok", "db_unavailable"}, Example: "ok"},
		}, "status"),
		"ReadyResponse": oaObjSchema(map[string]oaProp{
			"status":    {Type: "string", Description: "Readiness state", Enum: []string{"ready", "not_ready"}, Example: "ready"},
			"database":  {Type: "string", Description: "Database connectivity status", Example: "ok"},
			"blobs":     {Type: "string", Description: "Blob store status", Example: "ok"},
			"checkedAt": {Type: "string", Format: "date-time", Example: "2026-11-24T12:00:00Z"},
		}, "status"),
		"User": oaObjSchema(map[string]oaProp{
			"id":        {Type: "integer", Example: 1},
			"email":     {Type: "string", Format: "email", Example: "alice@example.com"},
			"name":      {Type: "string", Example: "Alice Zhang"},
			"createdAt": {Type: "string", Format: "date-time", Example: "2026-11-24T10:00:00Z"},
		}, "id", "email", "name"),
		"Workspace": oaObjSchema(map[string]oaProp{
			"id":      {Type: "integer", Example: 1},
			"name":    {Type: "string", Example: "Engineering Workspace"},
			"ownerId": {Type: "integer", Example: 1},
		}, "id", "name", "ownerId"),
		"DocMeta": oaObjSchema(map[string]oaProp{
			"id":               {Type: "integer", Example: 42},
			"workspaceId":      {Type: "integer", Example: 1},
			"parentId":         {Type: "integer", Description: "Parent folder ID (null for workspace root)"},
			"kind":             {Type: "string", Enum: []string{"doc", "base", "folder", "slides", "file", "sheet", "survey"}, Example: "doc"},
			"docType":          {Type: "string", Description: "Optional document subtype such as board"},
			"title":            {Type: "string", Example: "Q4 Architecture RFC"},
			"icon":             {Type: "string", Example: "📄"},
			"creatorId":        {Type: "integer", Example: 1},
			"creatorName":      {Type: "string", Example: "Alice Zhang"},
			"role":             {Type: "string", Enum: []string{"view", "edit", "manage"}, Example: "manage"},
			"copyProtected":    {Type: "boolean", Example: false},
			"inheritParentAcl": {Type: "boolean", Example: true},
			"driveRevision":    {Type: "integer", Example: 3},
			"createdAt":        {Type: "string", Format: "date-time", Example: "2026-11-24T10:00:00Z"},
			"updatedAt":        {Type: "string", Format: "date-time", Example: "2026-11-24T11:30:00Z"},
		}, "id", "workspaceId", "kind", "title"),
		"Comment": oaObjSchema(map[string]oaProp{
			"id":        {Type: "integer", Example: 101},
			"docId":     {Type: "integer", Example: 42},
			"userId":    {Type: "integer", Example: 1},
			"userName":  {Type: "string", Example: "Alice Zhang"},
			"parentId":  {Type: "integer", Description: "Parent comment ID for threaded replies"},
			"block":     {Type: "string", Description: "Anchored block ID"},
			"quote":     {Type: "string", Description: "Quoted document selection"},
			"body":      {Type: "string", Example: "Looks great — let's ship this."},
			"mentions":  {Type: "array", ItemsType: "integer"},
			"resolved":  {Type: "boolean", Example: false},
			"createdAt": {Type: "string", Format: "date-time"},
			"updatedAt": {Type: "string", Format: "date-time"},
		}, "id", "docId", "userId", "body", "resolved"),
		"BaseTable": oaObjSchema(map[string]oaProp{
			"id":        {Type: "integer", Example: 1},
			"baseId":    {Type: "integer", Example: 12},
			"name":      {Type: "string", Example: "Tasks"},
			"position":  {Type: "number", Example: 1000},
			"isDefault": {Type: "boolean", Example: true},
		}, "id", "baseId", "name"),
		"BaseField": oaObjSchema(map[string]oaProp{
			"id":          {Type: "integer", Example: 4},
			"baseId":      {Type: "integer", Example: 12},
			"tableId":     {Type: "integer", Example: 1},
			"name":        {Type: "string", Example: "Priority"},
			"type":        {Type: "string", Example: "select"},
			"options":     {Type: "array", ItemsType: "string", Example: []string{"High", "Medium", "Low"}},
			"description": {Type: "string"},
			"formula":     {Type: "string"},
			"position":    {Type: "number", Example: 2000},
			"isPrimary":   {Type: "boolean", Example: false},
		}, "id", "baseId", "name", "type"),
		"BaseRecord": oaObjSchema(map[string]oaProp{
			"id":        {Type: "integer", Example: 99},
			"baseId":    {Type: "integer", Example: 12},
			"tableId":   {Type: "integer", Example: 1},
			"cells":     {Type: "object", Description: "Map of stringified field ID to typed cell value"},
			"position":  {Type: "number", Example: 1000},
			"creatorId": {Type: "integer", Example: 1},
			"createdAt": {Type: "string", Format: "date-time"},
			"updatedAt": {Type: "string", Format: "date-time"},
		}, "id", "baseId", "cells"),
		"SheetWorkbook": oaObjSchema(map[string]oaProp{
			"nodeId":           {Type: "integer", Example: 10},
			"workspaceId":      {Type: "integer", Example: 1},
			"title":            {Type: "string", Example: "Q4 Financial Model"},
			"role":             {Type: "string", Enum: []string{"view", "edit", "manage"}, Example: "edit"},
			"driveRevision":    {Type: "integer", Example: 2},
			"workbookRevision": {Type: "integer", Example: 18},
			"sheets":           {Type: "array", ItemsType: "object", Description: "Worksheets with rows, columns, cells, merges, charts, and rules"},
			"updatedAt":        {Type: "string", Format: "date-time"},
		}, "nodeId", "workspaceId", "title", "sheets"),
		"SlidesDeck": oaObjSchema(map[string]oaProp{
			"slidesId": {Type: "integer", Example: 20},
			"title":    {Type: "string", Example: "Annual Architecture Review"},
			"role":     {Type: "string", Enum: []string{"view", "edit", "manage"}, Example: "edit"},
			"pages":    {Type: "array", ItemsRef: "SlidesPage", Description: "Ordered slide pages in the deck"},
		}, "pages"),
		"SlidesPage": oaObjSchema(map[string]oaProp{
			"id":         {Type: "integer", Example: 1},
			"slidesId":   {Type: "integer", Example: 20},
			"pos":        {Type: "number", Example: 1000},
			"title":      {Type: "string", Example: "Executive Summary"},
			"body":       {Type: "string"},
			"background": {Type: "string", Example: "#ffffff"},
			"layout":     {Type: "string", Example: "title_and_body"},
			"notes":      {Type: "string"},
			"shapes":     {Type: "array", ItemsType: "object", Description: "Vector canvas elements and shapes"},
			"hidden":     {Type: "boolean", Example: false},
			"revision":   {Type: "integer", Example: 5},
			"updatedAt":  {Type: "string", Format: "date-time"},
		}, "id", "slidesId", "pos", "revision"),
		"WikiSpace": oaObjSchema(map[string]oaProp{
			"id":          {Type: "integer", Example: 3},
			"workspaceId": {Type: "integer", Example: 1},
			"name":        {Type: "string", Example: "Engineering Handbook"},
			"description": {Type: "string", Example: "Architecture RFCs, runbooks, and onboarding guides"},
			"icon":        {Type: "string", Example: "📚"},
			"visibility":  {Type: "string", Enum: []string{"workspace", "private"}, Example: "workspace"},
			"creatorId":   {Type: "integer", Example: 1},
			"callerRole":  {Type: "string", Enum: []string{"view", "edit", "manage"}, Example: "manage"},
			"nodeCount":   {Type: "integer", Example: 24},
			"createdAt":   {Type: "string", Format: "date-time"},
			"updatedAt":   {Type: "string", Format: "date-time"},
		}, "id", "workspaceId", "name", "visibility"),
		"Webhook": oaObjSchema(map[string]oaProp{
			"id":          {Type: "integer", Example: 5},
			"workspaceId": {Type: "integer", Example: 1},
			"name":        {Type: "string", Example: "Enterprise Event Bus"},
			"url":         {Type: "string", Format: "uri", Example: "https://hooks.example.com/jiange"},
			"hasSecret":   {Type: "boolean", Example: true},
			"secretHint":  {Type: "string", Example: "whsec_****1234"},
			"events":      {Type: "array", ItemsType: "string", Example: []string{"doc.created", "share.updated"}},
			"enabled":     {Type: "boolean", Example: true},
			"createdAt":   {Type: "string", Format: "date-time"},
			"updatedAt":   {Type: "string", Format: "date-time"},
		}, "id", "workspaceId", "name", "url", "events", "enabled"),
		"NotificationChannel": oaObjSchema(map[string]oaProp{
			"id":          {Type: "integer", Example: 2},
			"workspaceId": {Type: "integer", Example: 1},
			"name":        {Type: "string", Example: "Engineering Feishu Alerts"},
			"kind":        {Type: "string", Enum: []string{"smtp", "feishu_bot", "dingtalk_bot", "wecom_bot", "slack_bot"}, Example: "feishu_bot"},
			"configHint":  {Type: "string", Example: "https://open.feishu.cn/open-apis/bot/v2/hook/****"},
			"events":      {Type: "array", ItemsType: "string", Example: []string{"mention", "comment_reply", "automation"}},
			"enabled":     {Type: "boolean", Example: true},
			"lastStatus":  {Type: "string", Example: "ok"},
			"lastError":   {Type: "string"},
			"createdAt":   {Type: "string", Format: "date-time"},
			"updatedAt":   {Type: "string", Format: "date-time"},
		}, "id", "workspaceId", "name", "kind", "events", "enabled"),
		"SecurityPolicy": oaObjSchema(map[string]oaProp{
			"workspaceId":         {Type: "integer", Example: 1},
			"watermarkEnabled":    {Type: "boolean", Example: true},
			"watermarkText":       {Type: "string", Example: "CONFIDENTIAL"},
			"watermarkShowUser":   {Type: "boolean", Example: true},
			"watermarkShowEmail":  {Type: "boolean", Example: true},
			"watermarkShowDate":   {Type: "boolean", Example: true},
			"watermarkOpacity":    {Type: "number", Example: 0.12},
			"dlpEnabled":          {Type: "boolean", Example: true},
			"dlpKeywords":         {Type: "array", ItemsType: "string", Example: []string{"SECRET_KEY", "/\\b\\d{16}\\b/"}},
			"dlpAction":           {Type: "string", Enum: []string{"warn", "block"}, Example: "block"},
			"dlpBlockPublicShare": {Type: "boolean", Example: true},
			"retentionDays":       {Type: "integer", Example: 90},
			"updatedBy":           {Type: "integer", Example: 1},
			"updatedAt":           {Type: "string", Format: "date-time"},
		}, "workspaceId", "watermarkEnabled", "dlpEnabled", "dlpAction", "retentionDays"),
		"DLPCheckResult": oaObjSchema(map[string]oaProp{
			"matched": {Type: "boolean", Example: true},
			"action":  {Type: "string", Enum: []string{"warn", "block"}, Example: "block"},
			"matches": {Type: "array", ItemsType: "object", Description: "List of matched DLP rules with snippet context"},
		}, "matched", "action", "matches"),
		"RetentionPurgeResult": oaObjSchema(map[string]oaProp{
			"workspaceId":     {Type: "integer", Example: 1},
			"retentionDays":   {Type: "integer", Example: 90},
			"purgedAuditLogs": {Type: "integer", Example: 120},
			"purgedTrashDocs": {Type: "integer", Example: 8},
			"cutoff":          {Type: "string", Format: "date-time", Example: "2026-08-26T00:00:00Z"},
			"dryRun":          {Type: "boolean", Example: false},
		}, "workspaceId", "retentionDays", "purgedAuditLogs", "purgedTrashDocs"),
		"AuditLogEntry": oaObjSchema(map[string]oaProp{
			"id":            {Type: "integer", Example: 501},
			"workspaceId":   {Type: "integer", Example: 1},
			"actorId":       {Type: "integer", Example: 1},
			"actorName":     {Type: "string", Example: "Alice Zhang"},
			"actorEmail":    {Type: "string", Example: "alice@example.com"},
			"action":        {Type: "string", Example: "scim.user_provision"},
			"resourceType":  {Type: "string", Example: "user"},
			"resourceId":    {Type: "integer", Example: 42},
			"resourceTitle": {Type: "string", Example: "bob@example.com"},
			"detail":        {Type: "object"},
			"ipAddress":     {Type: "string", Example: "192.0.2.10"},
			"userAgent":     {Type: "string"},
			"createdAt":     {Type: "string", Format: "date-time"},
		}, "id", "workspaceId", "action", "resourceType", "createdAt"),
		"PersonalAccessToken": oaObjSchema(map[string]oaProp{
			"id":          {Type: "integer", Example: 1},
			"name":        {Type: "string", Example: "Okta SCIM"},
			"tokenPrefix": {Type: "string", Example: "jg_pat_AbCdEfG"},
			"scopes":      {Type: "array", ItemsType: "string", Example: []string{"read", "write", "admin"}},
			"rawToken":    {Type: "string", Description: "Returned once on creation only"},
			"createdAt":   {Type: "string", Format: "date-time", Example: "2026-11-24T10:00:00Z"},
		}, "id", "name", "tokenPrefix", "scopes"),
		"SCIMError": oaObjSchema(map[string]oaProp{
			"schemas":  {Type: "array", ItemsType: "string", Example: []string{scimSchemaError}},
			"scimType": {Type: "string", Example: "invalidValue"},
			"detail":   {Type: "string", Example: "Resource not found"},
			"status":   {Type: "string", Example: "404"},
		}, "schemas", "detail", "status"),
		"SCIMUser": oaObjSchema(map[string]oaProp{
			"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaUser}},
			"id":          {Type: "string", Example: "42"},
			"externalId":  {Type: "string"},
			"userName":    {Type: "string", Format: "email", Example: "alice@example.com"},
			"displayName": {Type: "string", Example: "Alice Zhang"},
			"name":        {Type: "object"},
			"active":      {Type: "boolean", Example: true},
			"emails":      {Type: "array", ItemsType: "object"},
			"roles":       {Type: "array", ItemsType: "object"},
			"groups":      {Type: "array", ItemsType: "object"},
			"meta":        {Type: "object"},
		}, "schemas", "id", "userName", "active"),
		"SCIMGroup": oaObjSchema(map[string]oaProp{
			"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaGroup}},
			"id":          {Type: "string", Example: "7"},
			"externalId":  {Type: "string"},
			"displayName": {Type: "string", Example: "Engineering"},
			"members":     {Type: "array", ItemsType: "object"},
			"meta":        {Type: "object"},
		}, "schemas", "id", "displayName", "members"),
		"SCIMSchema": oaObjSchema(map[string]oaProp{
			"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaSchema}},
			"id":          {Type: "string", Example: scimSchemaUser},
			"name":        {Type: "string", Example: "User"},
			"description": {Type: "string", Example: "User Account"},
			"attributes":  {Type: "array", ItemsType: "object", Description: "RFC 7643 attribute descriptors"},
			"meta":        {Type: "object"},
		}, "schemas", "id", "name", "attributes"),
		"SCIMResourceType": oaObjSchema(map[string]oaProp{
			"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaResourceType}},
			"id":          {Type: "string", Example: "User"},
			"name":        {Type: "string", Example: "User"},
			"endpoint":    {Type: "string", Example: "/scim/v2/Users"},
			"description": {Type: "string", Example: "User Account"},
			"schema":      {Type: "string", Example: scimSchemaUser},
			"meta":        {Type: "object"},
		}, "schemas", "id", "name", "endpoint", "schema"),
		"SCIMListResponse": oaObjSchema(map[string]oaProp{
			"schemas":      {Type: "array", ItemsType: "string", Example: []string{scimSchemaListResponse}},
			"totalResults": {Type: "integer", Example: 2},
			"startIndex":   {Type: "integer", Example: 1},
			"itemsPerPage": {Type: "integer", Example: 2},
			"Resources":    {Type: "array", ItemsType: "object"},
		}, "schemas", "totalResults", "startIndex", "itemsPerPage", "Resources"),
	}
}

func oaOpsHealthAndDeveloper() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/healthz", Tag: "Health & Observability", OpID: "healthz",
			Summary: "Liveness health check",
			Desc:    "Checks process liveness and database ping responsiveness.",
			Resps: map[string]oaResp{
				"200": oaJSONResp("Service healthy", "HealthResponse"),
				"503": oaJSONResp("Database unavailable", "HealthResponse"),
			},
			Public: true,
		},
		{
			Method: "GET", Path: "/readyz", Tag: "Health & Observability", OpID: "readyz",
			Summary: "Readiness probe for orchestrators",
			Desc:    "Verifies database, storage, and subsystem readiness before routing production traffic.",
			Resps: map[string]oaResp{
				"200": oaJSONResp("Service ready to serve traffic", "ReadyResponse"),
				"503": oaJSONResp("Service not ready", "ReadyResponse"),
			},
			Public: true,
		},
		{
			Method: "GET", Path: "/metrics", Tag: "Health & Observability", OpID: "getMetrics",
			Summary: "Prometheus metrics scrape endpoint",
			Desc:    "Exposes HTTP request counters, latency histograms, runtime metrics, and active realtime hub gauges in Prometheus text exposition format.",
			Resps: map[string]oaResp{
				"200": oaTextResp("Prometheus text metrics exposition", "text/plain; version=0.0.4"),
			},
			Public: true,
		},
		{
			Method: "GET", Path: "/api/openapi.json", Tag: "Developer", OpID: "getOpenAPISpec",
			Summary: "Get OpenAPI 3.1.0 JSON specification",
			Desc:    "Returns the complete machine-readable OpenAPI 3.1.0 specification covering all Jiange REST and SCIM 2.0 endpoints.",
			Resps: map[string]oaResp{
				"200": oaJSONInlineResp("OpenAPI 3.1.0 JSON document", map[string]any{"type": "object"}),
			},
			Public: true,
		},
	}
}

func oaOpsAuthAndPAT() []oaRoute {
	mePayloadSchema := oaObjSchema(map[string]oaProp{
		"user":       {Ref: "User"},
		"workspaces": {Type: "array", ItemsRef: "Workspace"},
	}, "user", "workspaces")
	return []oaRoute{
		{
			Method: "POST", Path: "/api/auth/register", Tag: "Auth & MFA", OpID: "authRegister",
			Summary: "Register a new user account",
			Desc:    "Creates a user account, provisions a personal workspace, and issues an HttpOnly session cookie.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"email":    {Type: "string", Format: "email", Description: "User email address", Example: "alice@example.com"},
				"name":     {Type: "string", Description: "Display name (1-64 chars)", Example: "Alice"},
				"password": {Type: "string", Description: "Password (8-256 chars)"},
			}, "email", "name", "password"), "Registration credentials"),
			Resps: map[string]oaResp{
				"201": oaJSONInlineResp("Account created", mePayloadSchema),
				"400": oaErrResp("Invalid input"),
				"409": oaErrResp("Email already registered"),
			},
			Public: true,
		},
		{
			Method: "POST", Path: "/api/auth/login", Tag: "Auth & MFA", OpID: "authLogin",
			Summary: "Sign in with email and password",
			Desc:    "Verifies credentials and either starts a session or returns an MFA challenge when TOTP MFA is enabled.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"email":    {Type: "string", Format: "email", Example: "alice@example.com"},
				"password": {Type: "string"},
			}, "email", "password"), "Login credentials"),
			Resps: map[string]oaResp{
				"200": oaJSONInlineResp("Authenticated or MFA challenge issued", mePayloadSchema),
				"401": oaErrResp("Invalid credentials"),
			},
			Public: true,
		},
		{
			Method: "POST", Path: "/api/auth/logout", Tag: "Auth & MFA", OpID: "authLogout",
			Summary: "Sign out current session",
			Desc:    "Revokes the active browser session cookie and appends an audit entry.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Signed out")},
		},
		{
			Method: "POST", Path: "/api/auth/mfa/verify", Tag: "Auth & MFA", OpID: "verifyMFALogin",
			Summary: "Complete MFA login challenge",
			Desc:    "Validates a 6-digit TOTP code or one-time backup recovery code to complete sign-in.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"challengeToken": {Type: "string", Description: "Opaque MFA challenge token from login"},
				"code":           {Type: "string", Description: "6-digit TOTP code or recovery code", Example: "123456"},
			}, "challengeToken", "code"), "MFA verification payload"),
			Resps: map[string]oaResp{
				"200": oaJSONInlineResp("MFA verified and session started", mePayloadSchema),
				"401": oaErrResp("Invalid or expired challenge/code"),
			},
			Public: true,
		},
		{
			Method: "GET", Path: "/api/auth/sso/providers", Tag: "Auth & MFA", OpID: "listPublicSSOProviders",
			Summary: "List enabled enterprise SSO providers",
			Desc:    "Returns public metadata for enabled OIDC/OAuth2 identity providers for the login page.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Enabled SSO provider list", map[string]any{"type": "array", "items": map[string]any{"type": "object"}})},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/auth/sso/{slug}/start", Tag: "Auth & MFA", OpID: "startSSO",
			Summary: "Initiate enterprise SSO authentication",
			Desc:    "Redirects the browser to the configured OIDC/OAuth2 authorization endpoint with PKCE and state.",
			Resps:   map[string]oaResp{"302": oaPlainResp("Redirect to IdP"), "404": oaErrResp("SSO provider not found")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/auth/sso/{slug}/callback", Tag: "Auth & MFA", OpID: "callbackSSO",
			Summary: "Complete enterprise SSO OIDC/OAuth2 callback",
			Desc:    "Exchanges the authorization code with PKCE, provisions or matches the user, starts a session, and redirects to the app.",
			Params: []map[string]any{
				oaQueryParam("code", "string", "Authorization code from IdP", true),
				oaQueryParam("state", "string", "CSRF state token", true),
			},
			Resps:  map[string]oaResp{"302": oaPlainResp("Redirect to application"), "400": oaErrResp("Invalid SSO callback state or code")},
			Public: true,
		},
		{
			Method: "GET", Path: "/api/me", Tag: "Auth & MFA", OpID: "getMe",
			Summary: "Get current authenticated user and workspaces",
			Desc:    "Returns the caller's profile and all workspaces they belong to. Accepts Bearer PAT or session cookie.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Current user and workspaces", mePayloadSchema), "401": oaErrResp("Unauthorized")},
		},
		{
			Method: "GET", Path: "/api/me/mfa", Tag: "Auth & MFA", OpID: "getMyMFA",
			Summary: "Get personal MFA enrollment status",
			Desc:    "Returns whether TOTP MFA is enabled and the count of remaining backup recovery codes.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("MFA status", map[string]any{"type": "object"}), "401": oaErrResp("Unauthorized")},
		},
		{
			Method: "POST", Path: "/api/me/mfa/setup", Tag: "Auth & MFA", OpID: "setupMyMFA",
			Summary: "Initialize TOTP MFA secret",
			Desc:    "Generates a new TOTP secret and otpauth URI for authenticator app enrollment.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("TOTP setup details", map[string]any{"type": "object"}), "401": oaErrResp("Unauthorized")},
		},
		{
			Method: "POST", Path: "/api/me/mfa/enable", Tag: "Auth & MFA", OpID: "enableMyMFA",
			Summary: "Verify and enable TOTP MFA",
			Desc:    "Confirms the pending TOTP secret with a valid code and returns one-time backup recovery codes.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"code": {Type: "string", Description: "6-digit TOTP verification code", Example: "123456"},
			}, "code"), "TOTP confirmation code"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("MFA enabled with recovery codes", map[string]any{"type": "object"}), "400": oaErrResp("Invalid verification code")},
		},
		{
			Method: "POST", Path: "/api/me/mfa/disable", Tag: "Auth & MFA", OpID: "disableMyMFA",
			Summary: "Disable TOTP MFA",
			Desc:    "Disables TOTP MFA after verifying password or current TOTP/recovery code.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"code": {Type: "string", Description: "Current TOTP or backup code"},
			}, "code"), "MFA disable confirmation"),
			Resps: map[string]oaResp{"204": oaPlainResp("MFA disabled"), "400": oaErrResp("Invalid code")},
		},
		{
			Method: "GET", Path: "/api/me/tokens", Tag: "Personal Access Tokens", OpID: "listMyPATs",
			Summary: "List personal access tokens",
			Desc:    "Lists all Personal Access Tokens belonging to the authenticated user (never returns raw token secrets).",
			Resps:   map[string]oaResp{"200": oaJSONArrayResp("List of PAT metadata", "PersonalAccessToken"), "401": oaErrResp("Unauthorized")},
		},
		{
			Method: "POST", Path: "/api/me/tokens", Tag: "Personal Access Tokens", OpID: "createMyPAT",
			Summary: "Create a Personal Access Token",
			Desc:    "Creates a new Bearer PAT (`jg_pat_...`) with specified scopes (`read`, `write`, `admin`) and optional expiration. Raw token is returned once.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name":          {Type: "string", Description: "Token display name (1-80 chars)", Example: "CI Automation"},
				"scopes":        {Type: "array", ItemsType: "string", Description: "Allowed scopes: read, write, admin", Example: []string{"read", "write"}},
				"expiresInDays": {Type: "integer", Description: "Optional lifetime in days (1-365)", Example: 90},
			}, "name"), "PAT creation request"),
			Resps: map[string]oaResp{"201": oaJSONResp("PAT created with one-time rawToken", "PersonalAccessToken"), "400": oaErrResp("Invalid name, scopes, or expiry"), "409": oaErrResp("Maximum active PAT limit reached")},
		},
		{
			Method: "DELETE", Path: "/api/me/tokens/{tid}", Tag: "Personal Access Tokens", OpID: "revokeMyPAT",
			Summary: "Revoke a Personal Access Token",
			Desc:    "Immediately revokes the specified PAT so subsequent Bearer requests are rejected with 401.",
			Resps:   map[string]oaResp{"204": oaPlainResp("PAT revoked"), "404": oaErrResp("PAT not found")},
		},
		{
			Method: "GET", Path: "/api/me/templates", Tag: "Docs", OpID: "listUserTemplates",
			Summary: "List personal document templates",
			Desc:    "Returns reusable personal templates saved by the authenticated user.",
			Resps:   oaStdResp("200", "Personal template list", "", false),
		},
		{
			Method: "POST", Path: "/api/me/templates", Tag: "Docs", OpID: "addUserTemplate",
			Summary: "Save a personal document template",
			Desc:    "Saves a markdown/document body as a personal template.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name": {Type: "string", Example: "RFC Template"},
				"body": {Type: "string"},
			}, "name", "body"), "Template payload"),
			Resps: map[string]oaResp{"201": oaJSONInlineResp("Template saved", map[string]any{"type": "object"}), "400": oaErrResp("Invalid template")},
		},
		{
			Method: "DELETE", Path: "/api/me/templates/{tid}", Tag: "Docs", OpID: "deleteUserTemplate",
			Summary: "Delete a personal document template",
			Desc:    "Deletes the specified personal template owned by the authenticated user.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Template deleted"), "404": oaErrResp("Template not found")},
		},
		{
			Method: "GET", Path: "/api/link-preview", Tag: "Docs", OpID: "getLinkPreview",
			Summary: "Fetch safe OpenGraph metadata for a URL",
			Desc:    "Fetches title, description, and favicon for an external HTTP(S) URL with SSRF private-IP protection.",
			Params:  []map[string]any{oaQueryParam("url", "string", "Target external URL", true)},
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Link preview metadata", map[string]any{"type": "object"}), "400": oaErrResp("Invalid or disallowed URL")},
		},
	}
}

func oaOpsDocs() []oaRoute {
	wsQ := oaQueryParam("workspaceId", "integer", "Workspace ID", false)
	wsQReq := oaQueryParam("workspaceId", "integer", "Workspace ID", true)
	return []oaRoute{
		{
			Method: "GET", Path: "/api/docs", Tag: "Docs", OpID: "listDocs",
			Summary: "List workspace documents and nodes",
			Desc:    "Lists documents, sheets, bases, slides, and folders inside a workspace accessible to the caller.",
			Params:  []map[string]any{wsQReq},
			Resps:   oaStdResp("200", "Document list", "DocMeta", true),
		},
		{
			Method: "POST", Path: "/api/docs", Tag: "Docs", OpID: "createDoc",
			Summary: "Create a new document, sheet, base, or slide deck",
			Desc:    "Creates a new collaborative node inside the target workspace.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"workspaceId": {Type: "integer", Description: "Target workspace ID", Example: 1},
				"title":       {Type: "string", Description: "Document title", Example: "Q4 Architecture RFC"},
				"kind":        {Type: "string", Enum: []string{"doc", "sheet", "base", "slides", "survey"}, Example: "doc"},
				"parentId":    {Type: "integer", Description: "Optional parent folder ID"},
			}, "workspaceId", "title"), "Document creation payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Document created", "DocMeta"), "400": oaErrResp("Invalid parameters"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}", Tag: "Docs", OpID: "getDoc",
			Summary: "Get document metadata and content",
			Desc:    "Returns full document metadata, content snapshot, and caller permission role.",
			Resps:   map[string]oaResp{"200": oaJSONResp("Document details", "DocMeta"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Not found")},
		},
		{
			Method: "PATCH", Path: "/api/docs/{id}", Tag: "Docs", OpID: "patchDoc",
			Summary: "Update document title or metadata",
			Desc:    "Updates document title, icon, or editable metadata attributes.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"title": {Type: "string", Example: "Updated Title"},
			}), "Document patch payload"),
			Resps: map[string]oaResp{"200": oaJSONResp("Document updated", "DocMeta"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Not found")},
		},
		{
			Method: "DELETE", Path: "/api/docs/{id}", Tag: "Docs", OpID: "trashDoc",
			Summary: "Move document to trash",
			Desc:    "Soft-deletes the document into workspace trash.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Moved to trash"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Not found")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/account-metadata", Tag: "Docs", OpID: "getAccountDocMetadata",
			Summary: "Get account-bound document metadata",
			Desc:    "Returns document metadata validated against the caller's expected account identity header.",
			Resps:   oaStdResp("200", "Document metadata", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/duplicate", Tag: "Docs", OpID: "duplicateDoc",
			Summary: "Duplicate a document",
			Desc:    "Creates a copy of the document and its content in the same workspace.",
			Resps:   oaStdResp("201", "Duplicated document", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/account-duplicate", Tag: "Docs", OpID: "accountDuplicateDoc",
			Summary: "Duplicate a document with account guard",
			Desc:    "Duplicates a document while asserting the caller's active account identity.",
			Resps:   oaStdResp("201", "Duplicated document", "DocMeta", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/subpages", Tag: "Docs", OpID: "listDocSubpages",
			Summary: "List child subpages of a document",
			Desc:    "Returns nested child subpages attached beneath the specified document.",
			Resps:   oaStdResp("200", "Subpages list", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/ancestors", Tag: "Docs", OpID: "getDocAncestors",
			Summary: "Get ancestor breadcrumb chain for a document",
			Desc:    "Returns the ordered chain of parent folders/pages from workspace root to the document.",
			Resps:   oaStdResp("200", "Ancestor nodes", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/members", Tag: "Docs", OpID: "listDocMembers",
			Summary: "List members with access to a document",
			Desc:    "Returns workspace members eligible for @mentions and collaboration on the document.",
			Resps:   oaStdResp("200", "Document member list", "User", true),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/icon", Tag: "Docs", OpID: "getDocIcon",
			Summary: "Get document icon",
			Desc:    "Returns the emoji or custom icon configured for a document.",
			Resps:   oaStdResp("200", "Document icon metadata", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/icon", Tag: "Docs", OpID: "putDocIcon",
			Summary: "Set document icon",
			Desc:    "Updates or clears the icon displayed on a document.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"icon": {Type: "string", Example: "🚀"}}), "Icon payload"),
			Resps:   oaStdResp("200", "Updated icon", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/cover", Tag: "Docs", OpID: "getDocCover",
			Summary: "Get document cover configuration",
			Desc:    "Returns the banner cover metadata and focal offset for a document.",
			Resps:   oaStdResp("200", "Cover metadata", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/cover", Tag: "Docs", OpID: "putDocCover",
			Summary: "Update document cover configuration",
			Desc:    "Sets or clears a preset or uploaded document cover image.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"cover": {Type: "string"}, "position": {Type: "number"}}), "Cover settings"),
			Resps:   oaStdResp("200", "Updated cover", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/cover/image", Tag: "Docs", OpID: "getDocCoverImage",
			Summary: "Download document cover image",
			Desc:    "Streams the binary image file configured as the document cover.",
			Resps:   map[string]oaResp{"200": oaBinaryResp("Cover image binary"), "404": oaErrResp("No cover image")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/shares", Tag: "Docs", OpID: "getDocShares",
			Summary: "Get document sharing ACLs and link settings",
			Desc:    "Returns collaborators, department/group subject grants, inheritance mode, and public link policy.",
			Resps:   oaStdResp("200", "Share configuration", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/shares", Tag: "Docs", OpID: "putDocShare",
			Summary: "Grant or update collaborator permission on a document",
			Desc:    "Grants, updates, or revokes a user's `view`, `edit`, or `manage` access to the document.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"email": {Type: "string", Format: "email", Example: "bob@example.com"},
				"role":  {Type: "string", Enum: []string{"view", "edit", "manage", ""}},
			}, "email", "role"), "Collaborator permission payload"),
			Resps: oaStdResp("200", "Updated share list", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/shares-account", Tag: "Docs", OpID: "getDocSharesForAccount",
			Summary: "Get account-bound document sharing ACLs",
			Desc:    "Returns sharing ACLs while enforcing the caller's expected account guard.",
			Resps:   oaStdResp("200", "Share configuration", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/subject-shares", Tag: "Docs", OpID: "putDocSubjectShare",
			Summary: "Grant department or user-group permission on a document",
			Desc:    "Grants, updates, or revokes a department or user group's `view`, `edit`, or `manage` access.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"subjectType": {Type: "string", Enum: []string{"department", "group"}},
				"subjectId":   {Type: "integer"},
				"role":        {Type: "string", Enum: []string{"view", "edit", "manage", ""}},
			}, "subjectType", "subjectId", "role"), "Subject share grant"),
			Resps: oaStdResp("200", "Updated subject shares", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/inheritance", Tag: "Docs", OpID: "putDocInheritance",
			Summary: "Toggle parent folder ACL inheritance on a document",
			Desc:    "Enables or disables inheriting parent folder permissions while protecting the caller from self-lockout.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"inherit": {Type: "boolean"}}, "inherit"), "ACL inheritance toggle"),
			Resps:   oaStdResp("200", "Inheritance updated", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/link", Tag: "Docs", OpID: "putDocLink",
			Summary: "Configure document public share link",
			Desc:    "Updates public share link visibility (`off`, `view`, `edit`) and copy protection policy.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"access":        {Type: "string", Enum: []string{"off", "view", "edit"}, Example: "view"},
				"copyProtected": {Type: "boolean", Example: false},
			}, "access"), "Share link settings"),
			Resps: oaStdResp("200", "Updated share link", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/link-guarded", Tag: "Docs", OpID: "putDocLinkGuarded",
			Summary: "Configure document share link with optimistic revision check",
			Desc:    "Updates share link settings only when the caller's `permissionsRevision` matches the current revision.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"access":              {Type: "string", Enum: []string{"off", "view", "edit"}},
				"permissionsRevision": {Type: "integer"},
			}, "access", "permissionsRevision"), "Guarded share link settings"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("Updated share link", map[string]any{"type": "object"}), "409": oaErrResp("Permissions revision conflict")},
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/link-password", Tag: "Docs", OpID: "putDocLinkPassword",
			Summary: "Set or clear password protection on a document share link",
			Desc:    "Configures an optional access password required before viewing a public share link.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"password": {Type: "string"}}), "Share link password payload"),
			Resps:   oaStdResp("200", "Link password updated", "", false),
		},
		{
			Method: "POST", Path: "/api/share/{token}", Tag: "Docs", OpID: "joinShareLink",
			Summary: "Join a shared document via link token",
			Desc:    "Grants the authenticated user access according to the share link's active policy.",
			Resps:   oaStdResp("200", "Joined document metadata", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/share/{token}/join-guarded", Tag: "Docs", OpID: "joinShareLinkGuarded",
			Summary: "Join a shared document with session/account guard",
			Desc:    "Atomically joins a shared link while verifying active session and expected account.",
			Resps:   oaStdResp("200", "Joined document metadata", "DocMeta", false),
		},
		{
			Method: "GET", Path: "/api/share/{token}/paste-target", Tag: "Docs", OpID: "getSharePasteTarget",
			Summary: "Resolve a share link URL for smart paste embedding",
			Desc:    "Returns document preview metadata when pasting a share link inside an editor.",
			Resps:   oaStdResp("200", "Paste target metadata", "", false),
		},
		{
			Method: "GET", Path: "/api/shared", Tag: "Docs", OpID: "listSharedWithMe",
			Summary: "List documents shared with the caller",
			Desc:    "Returns documents explicitly shared with the authenticated user across workspaces.",
			Resps:   oaStdResp("200", "Shared document list", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/paste-target", Tag: "Docs", OpID: "getDocPasteTarget",
			Summary: "Resolve a document ID for smart paste cards",
			Desc:    "Returns minimal title, icon, and kind metadata for rendering link cards.",
			Resps:   oaStdResp("200", "Paste target metadata", "DocMeta", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/references", Tag: "Docs", OpID: "getDocReferences",
			Summary: "List inbound and outbound document references",
			Desc:    "Returns backlinks and outgoing @doc links for the document filtered by caller permissions.",
			Resps:   oaStdResp("200", "Reference list", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/reference-graph", Tag: "Docs", OpID: "getDocReferenceGraph",
			Summary: "Get local document knowledge graph",
			Desc:    "Returns nodes and directed edges for documents linked around the target document.",
			Resps:   oaStdResp("200", "Reference graph", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/reference-visibility", Tag: "Docs", OpID: "getDocReferenceVisibility",
			Summary: "Get document reference visibility preferences",
			Desc:    "Returns whether backlinks are visible for the document.",
			Resps:   oaStdResp("200", "Visibility configuration", "", false),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/reference-visibility", Tag: "Docs", OpID: "putDocReferenceVisibility",
			Summary: "Update document reference visibility preferences",
			Desc:    "Updates backlink visibility settings for the document.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"visible": {Type: "boolean"}}), "Reference visibility update"),
			Resps:   oaStdResp("200", "Visibility updated", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/reactions", Tag: "Docs", OpID: "getDocReactions",
			Summary: "List emoji reactions on a document",
			Desc:    "Returns aggregated emoji reaction counts and caller selections on the document.",
			Resps:   oaStdResp("200", "Document reactions", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/reactions", Tag: "Docs", OpID: "toggleDocReaction",
			Summary: "Toggle an emoji reaction on a document",
			Desc:    "Adds or removes the caller's reaction for a specific emoji on the document.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"emoji": {Type: "string", Example: "👍"}}, "emoji"), "Reaction emoji payload"),
			Resps:   oaStdResp("200", "Updated reactions", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/files", Tag: "Docs", OpID: "uploadDocFile",
			Summary: "Upload an attachment to a document",
			Desc:    "Uploads an image or binary file attachment scoped to the document.",
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Uploaded file metadata", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/docs/{id}/import-images", Tag: "Docs", OpID: "uploadDocImportImage",
			Summary: "Upload an image extracted during document import",
			Desc:    "Persists an embedded image during Markdown/Word/HTML import into the document.",
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Imported image metadata", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/docs/{id}/clipboard-assets", Tag: "Docs", OpID: "copyDocClipboardAssets",
			Summary: "Copy referenced file assets during cross-document paste",
			Desc:    "Clones file attachments referenced by pasted blocks into the target document.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"fileIds": {Type: "array", ItemsType: "integer"}}), "Clipboard asset IDs"),
			Resps:   oaStdResp("200", "Copied asset mapping", "", false),
		},
		{
			Method: "GET", Path: "/api/files/{id}", Tag: "Docs", OpID: "getFile",
			Summary: "Download an uploaded attachment file",
			Desc:    "Streams the file blob after verifying caller read/download permission on its owning document.",
			Resps:   map[string]oaResp{"200": oaBinaryResp("File content"), "403": oaErrResp("Forbidden"), "404": oaErrResp("File not found")},
		},
		{
			Method: "DELETE", Path: "/api/files/{id}", Tag: "Docs", OpID: "deleteFile",
			Summary: "Delete an uploaded attachment file",
			Desc:    "Removes an attachment file when the caller holds edit permission on its owning document.",
			Resps:   map[string]oaResp{"204": oaPlainResp("File deleted"), "403": oaErrResp("Forbidden"), "404": oaErrResp("File not found")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/versions", Tag: "Docs", OpID: "listDocVersions",
			Summary: "List document version snapshots",
			Desc:    "Returns version history entries for the document.",
			Resps:   oaStdResp("200", "Version list", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/versions", Tag: "Docs", OpID: "createDocVersion",
			Summary: "Save a document version snapshot",
			Desc:    "Records a new version snapshot of the current document state.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"label": {Type: "string", Example: "v1.0 Release"}}), "Version snapshot metadata"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Version snapshot created", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/docs/{id}/named-version", Tag: "Docs", OpID: "createNamedDocVersion",
			Summary: "Create a named milestone document version",
			Desc:    "Saves a guarded named version snapshot with explicit milestone title.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Launch Sign-off"}}, "name"), "Named version payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Named version created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/versions/{seq}", Tag: "Docs", OpID: "getDocVersion",
			Summary: "Get a specific document version snapshot",
			Desc:    "Returns the full snapshot content for the specified version sequence number.",
			Resps:   oaStdResp("200", "Version snapshot", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/versions/{seq}/restore", Tag: "Docs", OpID: "restoreDocVersion",
			Summary: "Restore a document to a previous version",
			Desc:    "Restores the document content from the specified version sequence number.",
			Resps:   oaStdResp("200", "Document restored", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/versions/{seq}/restore-guarded", Tag: "Docs", OpID: "restoreDocVersionGuarded",
			Summary: "Restore a document version with optimistic concurrency guard",
			Desc:    "Atomically restores a historical snapshot while validating current epoch/revision and active session.",
			Resps:   map[string]oaResp{"200": oaJSONResp("Document restored", "DocMeta"), "409": oaErrResp("Revision conflict")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/version-entries", Tag: "Docs", OpID: "listDocVersionEntries",
			Summary: "List managed document version entries",
			Desc:    "Returns named and auto-saved version entries visible in the version history drawer.",
			Resps:   oaStdResp("200", "Version entries", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/version-entries", Tag: "Docs", OpID: "createDocVersionEntry",
			Summary: "Create a managed document version entry",
			Desc:    "Creates a new managed version entry capturing the current document state.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}}), "Version entry payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Version entry created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/version-entries/trash", Tag: "Docs", OpID: "listDeletedDocVersionEntries",
			Summary: "List soft-deleted document version entries",
			Desc:    "Returns trashed version entries eligible for restoration.",
			Resps:   oaStdResp("200", "Trashed version entries", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/version-entries/{entry}/preview", Tag: "Docs", OpID: "previewDocVersionEntry",
			Summary: "Preview a saved document version entry",
			Desc:    "Returns read-only snapshot blocks for previewing a version entry before restoring.",
			Resps:   oaStdResp("200", "Version entry preview", "", false),
		},
		{
			Method: "PATCH", Path: "/api/docs/{id}/version-entries/{entry}", Tag: "Docs", OpID: "manageDocVersionEntry",
			Summary: "Rename, trash, or restore a saved version entry",
			Desc:    "Applies lifecycle actions (rename, delete, restore) to a managed version entry.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"action": {Type: "string"}, "name": {Type: "string"}}), "Version entry management payload"),
			Resps:   oaStdResp("200", "Version entry updated", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/title-consistency", Tag: "Docs", OpID: "getDocTitleConsistency",
			Summary: "Inspect document title consistency across metadata and body",
			Desc:    "Checks whether the document H1 title matches stored directory metadata.",
			Resps:   oaStdResp("200", "Title consistency status", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/title-consistency", Tag: "Docs", OpID: "reconcileDocTitleConsistency",
			Summary: "Reconcile document title consistency",
			Desc:    "Synchronizes document title metadata and snapshot heading atomically.",
			Resps:   oaStdResp("200", "Title reconciled", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/conditional-ops", Tag: "Docs", OpID: "commitDocConditionalOps",
			Summary: "Commit conditional document operations",
			Desc:    "Applies idempotent, revision-fenced document operations with receipt tracking.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"requestId": {Type: "string"}, "ops": {Type: "array", ItemsType: "object"}}), "Conditional operations payload"),
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Operations committed", map[string]any{"type": "object"}), "409": oaErrResp("Precondition conflict")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/conditional-ops/{requestId}", Tag: "Docs", OpID: "getDocConditionalOpsStatus",
			Summary: "Get conditional operation receipt status",
			Desc:    "Returns the commit or cancellation status of a conditional document operation request.",
			Resps:   oaStdResp("200", "Operation status", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/conditional-ops/{requestId}/cancel", Tag: "Docs", OpID: "cancelDocConditionalOps",
			Summary: "Cancel a pending conditional document operation",
			Desc:    "Records a cancellation fence for an in-flight conditional document request.",
			Resps:   oaStdResp("200", "Operation cancelled", "", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/comments", Tag: "Docs", OpID: "listDocComments",
			Summary: "List comments on a document",
			Desc:    "Returns inline and document-level comment threads.",
			Resps:   oaStdResp("200", "Document comments", "Comment", true),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/comments", Tag: "Docs", OpID: "addDocComment",
			Summary: "Add a comment to a document",
			Desc:    "Creates a new comment or reply anchored to a document block and range.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"body":     {Type: "string", Example: "Please clarify section 2."},
				"parentId": {Type: "integer"},
				"block":    {Type: "string"},
				"quote":    {Type: "string"},
			}, "body"), "Comment payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Comment created", "Comment"), "403": oaErrResp("Comment permission required")},
		},
		{
			Method: "PATCH", Path: "/api/docs/{id}/comments/{cid}", Tag: "Docs", OpID: "patchDocComment",
			Summary: "Edit or resolve a document comment",
			Desc:    "Updates comment text or toggles resolved status.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"body": {Type: "string"}, "resolved": {Type: "boolean"}}), "Comment patch"),
			Resps:   oaStdResp("200", "Updated comment", "Comment", false),
		},
		{
			Method: "PATCH", Path: "/api/docs/{id}/account-comments/{cid}", Tag: "Docs", OpID: "patchDocCommentForAccount",
			Summary: "Edit or resolve a document comment with account guard",
			Desc:    "Updates a document comment while asserting the caller's active account identity.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"body": {Type: "string"}, "resolved": {Type: "boolean"}}), "Comment patch"),
			Resps:   oaStdResp("200", "Updated comment", "Comment", false),
		},
		{
			Method: "DELETE", Path: "/api/docs/{id}/comments/{cid}", Tag: "Docs", OpID: "deleteDocComment",
			Summary: "Delete a document comment",
			Desc:    "Deletes a comment authored by the caller or managed by a document manager.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Comment deleted"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Comment not found")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/comment-attempts/capabilities", Tag: "Docs", OpID: "getDocCommentAttemptCapabilities",
			Summary: "Check idempotent comment attempt capabilities",
			Desc:    "Returns whether idempotent comment submission is enabled and permitted for the caller.",
			Resps:   oaStdResp("200", "Capabilities", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/comment-attempts", Tag: "Docs", OpID: "addDocCommentAttempt",
			Summary: "Submit an idempotent document comment",
			Desc:    "Creates a comment keyed by client mutationId so retries never produce duplicate comments.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"mutationId": {Type: "string"}, "body": {Type: "string"}}, "mutationId", "body"), "Idempotent comment payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Comment recorded", "Comment"), "200": oaJSONResp("Previously committed comment", "Comment")},
		},
		{
			Method: "GET", Path: "/api/docs/{id}/comment-attempts/{mutationId}", Tag: "Docs", OpID: "getDocCommentAttempt",
			Summary: "Lookup an idempotent document comment receipt",
			Desc:    "Checks the result of a prior idempotent comment mutation.",
			Resps:   oaStdResp("200", "Comment attempt result", "Comment", false),
		},
		{
			Method: "GET", Path: "/api/docs/{id}/suggestions", Tag: "Docs", OpID: "listDocSuggestions",
			Summary: "List tracked-change suggestions on a document",
			Desc:    "Returns open and resolved suggested edits for collaborative review.",
			Resps:   oaStdResp("200", "Suggestion list", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/suggestions", Tag: "Docs", OpID: "createDocSuggestion",
			Summary: "Create a tracked-change suggestion",
			Desc:    "Proposes a structured text replacement or note on a document block.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"block": {Type: "string"}, "original": {Type: "string"}, "proposed": {Type: "string"}, "note": {Type: "string"}}), "Suggestion payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Suggestion created", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PATCH", Path: "/api/docs/{id}/suggestions/{sid}", Tag: "Docs", OpID: "patchDocSuggestion",
			Summary: "Update a suggestion review note",
			Desc:    "Updates the review note attached to an open suggestion.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"note": {Type: "string"}}), "Suggestion note update"),
			Resps:   oaStdResp("200", "Suggestion updated", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/suggestions/{sid}/accept", Tag: "Docs", OpID: "acceptDocSuggestion",
			Summary: "Accept a tracked-change suggestion",
			Desc:    "Marks the suggestion as accepted and applies its review resolution.",
			Resps:   oaStdResp("200", "Suggestion accepted", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/suggestions/{sid}/reject", Tag: "Docs", OpID: "rejectDocSuggestion",
			Summary: "Reject a tracked-change suggestion",
			Desc:    "Marks the suggestion as rejected.",
			Resps:   oaStdResp("200", "Suggestion rejected", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/suggestions/{sid}/withdraw", Tag: "Docs", OpID: "withdrawDocSuggestion",
			Summary: "Withdraw a tracked-change suggestion",
			Desc:    "Allows the author to withdraw an open suggestion.",
			Resps:   oaStdResp("200", "Suggestion withdrawn", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/suggestions/accept-all", Tag: "Docs", OpID: "acceptAllDocSuggestions",
			Summary: "Accept all open suggestions on a document",
			Desc:    "Batch-accepts all pending review suggestions on the document.",
			Resps:   oaStdResp("200", "All suggestions accepted", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/suggestions/reject-all", Tag: "Docs", OpID: "rejectAllDocSuggestions",
			Summary: "Reject all open suggestions on a document",
			Desc:    "Batch-rejects all pending review suggestions on the document.",
			Resps:   oaStdResp("200", "All suggestions rejected", "", false),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/synced-blocks", Tag: "Docs", OpID: "createSyncedBlock",
			Summary: "Create a reusable synced block",
			Desc:    "Registers a synced block owned by the document that can be embedded across documents.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"content": {Type: "object"}}), "Synced block content"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Synced block created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "GET", Path: "/api/synced-blocks/{sid}", Tag: "Docs", OpID: "getSyncedBlock",
			Summary: "Get a synced block by ID",
			Desc:    "Returns the latest content and revision of a synced block.",
			Resps:   oaStdResp("200", "Synced block", "", false),
		},
		{
			Method: "PUT", Path: "/api/synced-blocks/{sid}", Tag: "Docs", OpID: "updateSyncedBlock",
			Summary: "Update a synced block",
			Desc:    "Updates the shared content of a synced block across all referencing documents.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"content": {Type: "object"}}), "Updated synced block content"),
			Resps:   oaStdResp("200", "Synced block updated", "", false),
		},
		{
			Method: "GET", Path: "/api/search", Tag: "Docs", OpID: "searchDocs",
			Summary: "Full-text search across accessible documents",
			Desc:    "Searches titles and indexed content across workspaces the caller can read.",
			Params:  []map[string]any{oaQueryParam("q", "string", "Search query keywords", true), wsQ},
			Resps:   oaStdResp("200", "Matching documents", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/account-document-search", Tag: "Docs", OpID: "searchAccountDocuments",
			Summary: "Account-guarded full-text document search",
			Desc:    "Performs full-text document search while asserting the caller's expected account header.",
			Params:  []map[string]any{oaQueryParam("q", "string", "Search query keywords", true), wsQ},
			Resps:   oaStdResp("200", "Matching documents", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/favorites", Tag: "Docs", OpID: "listFavorites",
			Summary: "List starred favorite documents",
			Desc:    "Returns documents starred by the authenticated user.",
			Params:  []map[string]any{wsQ},
			Resps:   oaStdResp("200", "Favorite documents", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/account-favorites", Tag: "Docs", OpID: "listAccountFavorites",
			Summary: "List account-guarded favorite documents",
			Desc:    "Returns starred documents verified against the expected account header.",
			Params:  []map[string]any{wsQ},
			Resps:   oaStdResp("200", "Favorite documents", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/pins", Tag: "Docs", OpID: "listPins",
			Summary: "List pinned documents",
			Desc:    "Returns documents pinned to the top navigation for the authenticated user.",
			Params:  []map[string]any{wsQ},
			Resps:   oaStdResp("200", "Pinned documents", "DocMeta", true),
		},
		{
			Method: "GET", Path: "/api/account-pins", Tag: "Docs", OpID: "listAccountPins",
			Summary: "List account-guarded pinned documents",
			Desc:    "Returns pinned documents verified against the expected account header.",
			Params:  []map[string]any{wsQ},
			Resps:   oaStdResp("200", "Pinned documents", "DocMeta", true),
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/pin", Tag: "Docs", OpID: "pinDoc",
			Summary: "Pin a document",
			Desc:    "Pins the document to the caller's quick-access sidebar.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document pinned"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "DELETE", Path: "/api/docs/{id}/pin", Tag: "Docs", OpID: "unpinDoc",
			Summary: "Unpin a document",
			Desc:    "Removes the document from the caller's pinned list.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document unpinned"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/account-pin", Tag: "Docs", OpID: "accountPinDoc",
			Summary: "Pin a document with account guard",
			Desc:    "Pins a document while verifying the caller's active account identity.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document pinned"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "DELETE", Path: "/api/docs/{id}/account-pin", Tag: "Docs", OpID: "accountUnpinDoc",
			Summary: "Unpin a document with account guard",
			Desc:    "Unpins a document while verifying the caller's active account identity.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document unpinned"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/star", Tag: "Docs", OpID: "starDoc",
			Summary: "Star a document as favorite",
			Desc:    "Adds the document to the caller's favorites list.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document starred"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "DELETE", Path: "/api/docs/{id}/star", Tag: "Docs", OpID: "unstarDoc",
			Summary: "Remove document from favorites",
			Desc:    "Removes the document from the caller's favorites list.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document unstarred"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PUT", Path: "/api/docs/{id}/account-star", Tag: "Docs", OpID: "accountStarDoc",
			Summary: "Star a document with account guard",
			Desc:    "Adds the document to favorites while asserting the expected account header.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document starred"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "DELETE", Path: "/api/docs/{id}/account-star", Tag: "Docs", OpID: "accountUnstarDoc",
			Summary: "Unstar a document with account guard",
			Desc:    "Removes the document from favorites while asserting the expected account header.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Document unstarred"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/recent", Tag: "Docs", OpID: "listRecentDocs",
			Summary: "List recently visited documents",
			Desc:    "Returns documents recently opened by the caller ordered by last visit timestamp.",
			Params:  []map[string]any{wsQ},
			Resps:   oaStdResp("200", "Recent documents", "DocMeta", true),
		},
		{
			Method: "POST", Path: "/api/docs/{id}/visit", Tag: "Docs", OpID: "recordDocVisit",
			Summary: "Record a document visit",
			Desc:    "Updates the caller's recent-documents timestamp for this document.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Visit recorded"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/notifications", Tag: "Docs", OpID: "listNotifications",
			Summary: "List inbox notifications",
			Desc:    "Returns @mention, comment reply, and collaboration notifications for the caller.",
			Resps:   oaStdResp("200", "Notifications list", "", false),
		},
		{
			Method: "POST", Path: "/api/notifications/read", Tag: "Docs", OpID: "markNotificationsRead",
			Summary: "Mark notifications as read",
			Desc:    "Marks specific notification IDs or all unread notifications as read.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"ids": {Type: "array", ItemsType: "integer"}}), "Notification IDs to mark read"),
			Resps:   map[string]oaResp{"204": oaPlainResp("Marked as read"), "401": oaErrResp("Unauthorized")},
		},
		{
			Method: "GET", Path: "/api/trash", Tag: "Docs", OpID: "listTrash",
			Summary: "List trashed documents in a workspace",
			Desc:    "Returns soft-deleted documents and folders currently in workspace trash.",
			Params:  []map[string]any{wsQ},
			Resps:   oaStdResp("200", "Trashed documents", "DocMeta", true),
		},
		{
			Method: "POST", Path: "/api/trash/{id}/restore", Tag: "Docs", OpID: "restoreTrashedDoc",
			Summary: "Restore a document from trash",
			Desc:    "Restores a soft-deleted document back to its workspace location.",
			Resps:   oaStdResp("200", "Restored document", "DocMeta", false),
		},
	}
}

func oaOpsSheets() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/api/sheets/{id}", Tag: "Sheets", OpID: "getSheetWorkbook",
			Summary: "Get spreadsheet workbook snapshot",
			Desc:    "Returns worksheets, cells, styles, merged ranges, defined names, charts, and conditional formats.",
			Resps:   map[string]oaResp{"200": oaJSONResp("Sheet workbook snapshot", "SheetWorkbook"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Not found")},
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/account-title", Tag: "Sheets", OpID: "renameSheetForAccount",
			Summary: "Rename spreadsheet with account guard",
			Desc:    "Updates the spreadsheet title while validating the caller's expected account identity.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}}, "title"), "Sheet rename payload"),
			Resps:   oaStdResp("200", "Updated sheet metadata", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/cells", Tag: "Sheets", OpID: "writeSheetCells",
			Summary: "Batch update spreadsheet cells",
			Desc:    "Applies cell value, formula, and style updates to a worksheet atomically with revision conflict detection.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"mutationId":  {Type: "string", Description: "Optional 32-hex idempotency key"},
				"worksheetId": {Type: "integer", Example: 1},
				"cells":       {Type: "array", ItemsType: "object", Description: "Cell write operations"},
			}, "worksheetId", "cells"), "Batch cell update payload"),
			Resps: map[string]oaResp{"200": oaJSONResp("Cells updated", "SheetWorkbook"), "400": oaErrResp("Invalid cell payload"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/worksheets", Tag: "Sheets", OpID: "createWorksheet",
			Summary: "Add a worksheet tab to a spreadsheet",
			Desc:    "Creates a new worksheet tab inside the workbook.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string", Example: "Summary"}}, "title"), "Worksheet creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Worksheet created", "SheetWorkbook"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "PATCH", Path: "/api/sheets/{id}/worksheets/{wid}", Tag: "Sheets", OpID: "updateWorksheetMeta",
			Summary: "Update worksheet title, freeze panes, merges, charts, or rules",
			Desc:    "Modifies worksheet metadata, filters, validations, conditional formats, protected ranges, or charts.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}, "frozenRows": {Type: "integer"}, "frozenCols": {Type: "integer"}}), "Worksheet metadata patch"),
			Resps:   oaStdResp("200", "Worksheet updated", "SheetWorkbook", false),
		},
		{
			Method: "DELETE", Path: "/api/sheets/{id}/worksheets/{wid}", Tag: "Sheets", OpID: "deleteWorksheet",
			Summary: "Delete a worksheet tab",
			Desc:    "Removes the specified worksheet tab from the workbook.",
			Resps:   map[string]oaResp{"200": oaJSONResp("Worksheet deleted", "SheetWorkbook"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/worksheets/{wid}/axes", Tag: "Sheets", OpID: "mutateSheetAxis",
			Summary: "Insert, delete, or resize worksheet rows or columns",
			Desc:    "Performs structural row/column mutations on a worksheet.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"axis": {Type: "string", Enum: []string{"row", "col"}}, "op": {Type: "string"}}, "axis", "op"), "Axis mutation payload"),
			Resps:   oaStdResp("200", "Axes mutated", "SheetWorkbook", false),
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/import-xlsx", Tag: "Sheets", OpID: "importSheetXlsx",
			Summary: "Import XLSX worksheets and cells into a spreadsheet",
			Desc:    "Imports parsed workbook tabs, cells, and styles into the spreadsheet.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"sheets": {Type: "array", ItemsType: "object"}}), "XLSX import payload"),
			Resps:   oaStdResp("200", "Workbook imported", "SheetWorkbook", false),
		},
		{
			Method: "GET", Path: "/api/sheets/{id}/comments", Tag: "Sheets", OpID: "listSheetComments",
			Summary: "List spreadsheet cell comments",
			Desc:    "Returns comments attached to cells across worksheets in the workbook.",
			Resps:   oaStdResp("200", "Sheet comments", "Comment", true),
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/comments", Tag: "Sheets", OpID: "createSheetComment",
			Summary: "Add a comment to a spreadsheet cell",
			Desc:    "Creates a new cell-anchored comment thread.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"worksheetId": {Type: "integer"}, "rowId": {Type: "integer"}, "columnId": {Type: "integer"}, "body": {Type: "string"}}, "body"), "Sheet comment payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Comment created", "Comment"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PATCH", Path: "/api/sheets/{id}/comments/{cid}", Tag: "Sheets", OpID: "patchSheetComment",
			Summary: "Update or resolve a spreadsheet comment",
			Desc:    "Updates comment content or resolved state on a spreadsheet comment.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"body": {Type: "string"}, "resolved": {Type: "boolean"}}), "Sheet comment patch"),
			Resps:   oaStdResp("200", "Comment updated", "Comment", false),
		},
		{
			Method: "DELETE", Path: "/api/sheets/{id}/comments/{cid}", Tag: "Sheets", OpID: "deleteSheetComment",
			Summary: "Delete a spreadsheet comment",
			Desc:    "Deletes the specified spreadsheet cell comment.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Comment deleted"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/sheets/{id}/versions", Tag: "Sheets", OpID: "listSheetVersions",
			Summary: "List spreadsheet version snapshots",
			Desc:    "Returns saved workbook version snapshots.",
			Resps:   oaStdResp("200", "Sheet versions", "", false),
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/versions", Tag: "Sheets", OpID: "createSheetVersion",
			Summary: "Create spreadsheet version snapshot",
			Desc:    "Captures a named snapshot of the spreadsheet workbook.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"label": {Type: "string", Example: "Month-End Close"}}), "Sheet snapshot label"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Version created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/sheets/{id}/versions/{vid}/restore", Tag: "Sheets", OpID: "restoreSheetVersion",
			Summary: "Restore a spreadsheet version snapshot",
			Desc:    "Restores the workbook to the selected historical version.",
			Resps:   oaStdResp("200", "Workbook restored", "SheetWorkbook", false),
		},
		{
			Method: "GET", Path: "/api/sheets/{id}/cell-history", Tag: "Sheets", OpID: "listSheetCellHistory",
			Summary: "Get edit history for a spreadsheet cell",
			Desc:    "Returns chronological change entries for a worksheet cell coordinate.",
			Params: []map[string]any{
				oaQueryParam("worksheetId", "integer", "Worksheet ID", true),
				oaQueryParam("rowId", "integer", "Row ID", true),
				oaQueryParam("columnId", "integer", "Column ID", true),
			},
			Resps: oaStdResp("200", "Cell edit history", "", false),
		},
		{
			Method: "GET", Path: "/api/sheets/{id}/defined-names", Tag: "Sheets", OpID: "getSheetDefinedNames",
			Summary: "List spreadsheet defined named ranges",
			Desc:    "Returns named formula ranges configured on the workbook.",
			Resps:   oaStdResp("200", "Defined names", "", false),
		},
		{
			Method: "PUT", Path: "/api/sheets/{id}/defined-names", Tag: "Sheets", OpID: "putSheetDefinedNames",
			Summary: "Save spreadsheet defined named ranges",
			Desc:    "Replaces or updates named formula ranges on the workbook.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"definedNames": {Type: "array", ItemsType: "object"}}, "definedNames"), "Defined names payload"),
			Resps:   oaStdResp("200", "Defined names saved", "", false),
		},
	}
}

func oaOpsBases() []oaRoute {
	return []oaRoute{
		{
			Method: "POST", Path: "/api/bases", Tag: "Bases", OpID: "createBase",
			Summary: "Create a new Base (multi-dimensional table)",
			Desc:    "Creates a Base document with a default table, fields, and grid view.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"workspaceId": {Type: "integer", Example: 1},
				"title":       {Type: "string", Example: "Product Roadmap"},
			}, "workspaceId", "title"), "Base creation payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Base created", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/bases/{id}", Tag: "Bases", OpID: "getBase",
			Summary: "Get Base schema, views, and records",
			Desc:    "Returns tables, fields, views, and projected records respecting field-level RBAC.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Base snapshot", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden"), "404": oaErrResp("Not found")},
		},
		{
			Method: "GET", Path: "/api/bases/{id}/account-snapshot", Tag: "Bases", OpID: "getBaseAccountSnapshot",
			Summary: "Get account-guarded Base snapshot",
			Desc:    "Returns a full Base snapshot while asserting the caller's expected account header.",
			Resps:   oaStdResp("200", "Base snapshot", "", false),
		},
		{
			Method: "GET", Path: "/api/bases/{id}/tables", Tag: "Bases", OpID: "listBaseTables",
			Summary: "List data tables inside a Base",
			Desc:    "Returns all tables configured within a multi-table Base.",
			Resps:   oaStdResp("200", "Base tables", "BaseTable", true),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/tables", Tag: "Bases", OpID: "createBaseTable",
			Summary: "Create a new data table in a Base",
			Desc:    "Adds a new data table with default primary field and grid view.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Milestones"}}, "name"), "Base table creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Table created", "BaseTable"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/tables/{tid}", Tag: "Bases", OpID: "renameBaseTable",
			Summary: "Rename a Base table",
			Desc:    "Updates the display name of a table inside the Base.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}}, "name"), "Table rename payload"),
			Resps:   oaStdResp("200", "Table renamed", "BaseTable", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/tables/{tid}", Tag: "Bases", OpID: "deleteBaseTable",
			Summary: "Delete a Base table",
			Desc:    "Deletes a non-last data table from the Base.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Table deleted"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/tables/reorder", Tag: "Bases", OpID: "reorderBaseTables",
			Summary: "Reorder tables inside a Base",
			Desc:    "Updates display order positions of tables within the Base.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"tableIds": {Type: "array", ItemsType: "integer"}}, "tableIds"), "Ordered table IDs"),
			Resps:   oaStdResp("200", "Tables reordered", "BaseTable", true),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/fields", Tag: "Bases", OpID: "addBaseField",
			Summary: "Add a typed column field to a Base table",
			Desc:    "Creates a new column field (text, number, select, date, person, link, formula, etc.).",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Status"}, "type": {Type: "string", Example: "select"}, "tableId": {Type: "integer"}}, "name", "type"), "Field creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Field created", "BaseField"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/fields/reorder", Tag: "Bases", OpID: "reorderBaseFields",
			Summary: "Reorder fields in a Base table",
			Desc:    "Updates column display order for the Base table.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"fieldIds": {Type: "array", ItemsType: "integer"}}, "fieldIds"), "Ordered field IDs"),
			Resps:   oaStdResp("200", "Fields reordered", "BaseField", true),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/fields/restore", Tag: "Bases", OpID: "restoreBaseField",
			Summary: "Restore a recently deleted Base field",
			Desc:    "Restores a field and its cell values (undo field deletion).",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"field": {Type: "object"}, "cells": {Type: "object"}}), "Field restore payload"),
			Resps:   oaStdResp("200", "Field restored", "BaseField", false),
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/fields/{fid}", Tag: "Bases", OpID: "patchBaseField",
			Summary: "Update a Base field definition",
			Desc:    "Updates field name, type, options, formula, or default value.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "type": {Type: "string"}, "options": {Type: "array", ItemsType: "string"}}), "Field patch payload"),
			Resps:   oaStdResp("200", "Field updated", "BaseField", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/fields/{fid}", Tag: "Bases", OpID: "deleteBaseField",
			Summary: "Delete a Base field",
			Desc:    "Removes a non-primary field from the Base table.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Field deleted", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records", Tag: "Bases", OpID: "addBaseRecord",
			Summary: "Insert a record into a Base table",
			Desc:    "Adds a new row with typed field values and evaluates formulas & automations.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"tableId": {Type: "integer", Description: "Optional table ID inside the Base"},
				"cells":   {Type: "object", Description: "Map of fieldId -> cell value"},
			}, "cells"), "New record payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Record inserted", "BaseRecord"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/records/{rid}", Tag: "Bases", OpID: "updateBaseRecord",
			Summary: "Update a Base record",
			Desc:    "Updates one or more cells on an existing Base record.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"cells": {Type: "object"}}, "cells"), "Record cell patch"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Record updated", "BaseRecord"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Record not found")},
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/records/{rid}", Tag: "Bases", OpID: "deleteBaseRecord",
			Summary: "Delete a Base record",
			Desc:    "Removes the specified record from the Base.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Record deleted", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden"), "404": oaErrResp("Record not found")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records/batch-delete", Tag: "Bases", OpID: "batchDeleteBaseRecords",
			Summary: "Batch delete Base records",
			Desc:    "Atomically deletes multiple Base records by ID.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"recordIds": {Type: "array", ItemsType: "integer"}}, "recordIds"), "Record IDs to delete"),
			Resps:   oaStdResp("200", "Records deleted", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records/batch-restore", Tag: "Bases", OpID: "batchRestoreBaseRecords",
			Summary: "Batch restore Base records",
			Desc:    "Restores previously deleted records (undo batch delete).",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"records": {Type: "array", ItemsType: "object"}}, "records"), "Records to restore"),
			Resps:   oaStdResp("200", "Records restored", "BaseRecord", true),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records/batch-update", Tag: "Bases", OpID: "batchUpdateBaseRecords",
			Summary: "Batch update Base records",
			Desc:    "Applies cell updates across multiple records in a single transaction.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"updates": {Type: "array", ItemsType: "object"}}, "updates"), "Batch cell updates"),
			Resps:   oaStdResp("200", "Records updated", "BaseRecord", true),
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/records/{rid}/compare-cells", Tag: "Bases", OpID: "compareBaseDateCells",
			Summary: "Conditionally update Base record date cells",
			Desc:    "Performs optimistic compare-and-swap updates on date/timeline cells.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"expected": {Type: "object"}, "cells": {Type: "object"}}), "Compare-and-swap cell payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Record updated", "BaseRecord"), "409": oaErrResp("Cell value mismatch")},
		},
		{
			Method: "GET", Path: "/api/bases/{id}/records/{rid}/history", Tag: "Bases", OpID: "getBaseRecordHistory",
			Summary: "Get change history for a Base record",
			Desc:    "Returns field-level modification events recorded for the row.",
			Resps:   oaStdResp("200", "Record change events", "", false),
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/records/{rid}/kanban-move", Tag: "Bases", OpID: "moveBaseKanbanCard",
			Summary: "Move a Base record card across Kanban lanes",
			Desc:    "Updates lane grouping value and card ordering position atomically.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"fieldId": {Type: "integer"}, "value": {Type: "string"}, "position": {Type: "number"}}), "Kanban move payload"),
			Resps:   oaStdResp("200", "Card moved", "BaseRecord", false),
		},
		{
			Method: "GET", Path: "/api/bases/{id}/records/{rid}/comments", Tag: "Bases", OpID: "listBaseRecordComments",
			Summary: "List comments on a Base record",
			Desc:    "Returns comment threads attached to a Base record.",
			Resps:   oaStdResp("200", "Record comments", "Comment", true),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records/{rid}/comments", Tag: "Bases", OpID: "addBaseRecordComment",
			Summary: "Add a comment to a Base record",
			Desc:    "Posts a new comment on a Base record and triggers @mention notifications.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"body": {Type: "string"}}, "body"), "Record comment payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Comment added", "Comment"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/records/{rid}/comments/{cid}", Tag: "Bases", OpID: "patchBaseRecordComment",
			Summary: "Update a Base record comment",
			Desc:    "Edits the body of a Base record comment.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"body": {Type: "string"}}, "body"), "Comment edit payload"),
			Resps:   oaStdResp("200", "Comment updated", "Comment", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/records/{rid}/comments/{cid}", Tag: "Bases", OpID: "deleteBaseRecordComment",
			Summary: "Delete a Base record comment",
			Desc:    "Deletes a comment on a Base record.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Comment deleted"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records/{rid}/comments/{cid}/reactions", Tag: "Bases", OpID: "setBaseRecordCommentReaction",
			Summary: "Toggle an emoji reaction on a Base record comment",
			Desc:    "Adds or removes the caller's emoji reaction on a record comment.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"emoji": {Type: "string", Example: "🎉"}}, "emoji"), "Reaction payload"),
			Resps:   oaStdResp("200", "Updated reactions", "", false),
		},
		{
			Method: "GET", Path: "/api/bases/{id}/records/{rid}/comment-attempts/capabilities", Tag: "Bases", OpID: "getBaseRecordCommentAttemptCapabilities",
			Summary: "Check idempotent Base record comment capabilities",
			Desc:    "Reports whether idempotent record comment submission is available for the caller.",
			Resps:   oaStdResp("200", "Capabilities", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/records/{rid}/comment-attempts", Tag: "Bases", OpID: "addBaseRecordCommentAttempt",
			Summary: "Submit an idempotent Base record comment",
			Desc:    "Submits a record comment deduplicated by client mutationId.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"mutationId": {Type: "string"}, "body": {Type: "string"}}, "mutationId", "body"), "Idempotent record comment payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Comment recorded", "Comment"), "200": oaJSONResp("Existing receipt", "Comment")},
		},
		{
			Method: "GET", Path: "/api/bases/{id}/records/{rid}/comment-attempts/{mutationId}", Tag: "Bases", OpID: "getBaseRecordCommentAttempt",
			Summary: "Lookup an idempotent Base record comment receipt",
			Desc:    "Retrieves the result of a previous idempotent record comment attempt.",
			Resps:   oaStdResp("200", "Comment attempt result", "Comment", false),
		},
		{
			Method: "GET", Path: "/api/bases/{id}/dashboards", Tag: "Bases", OpID: "listBaseDashboards",
			Summary: "List BI dashboards attached to a Base",
			Desc:    "Returns configured chart/KPI dashboards for the Base.",
			Resps:   oaStdResp("200", "Dashboards list", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/dashboards", Tag: "Bases", OpID: "createBaseDashboard",
			Summary: "Create a Base BI dashboard",
			Desc:    "Creates a new dashboard layout with chart and metric widgets.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Sprint Velocity"}, "widgets": {Type: "array", ItemsType: "object"}}, "name"), "Dashboard payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Dashboard created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/dashboards/{did}", Tag: "Bases", OpID: "patchBaseDashboard",
			Summary: "Update a Base BI dashboard",
			Desc:    "Updates dashboard title, layout, or widget configurations.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "widgets": {Type: "array", ItemsType: "object"}}), "Dashboard update payload"),
			Resps:   oaStdResp("200", "Dashboard updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/dashboards/{did}", Tag: "Bases", OpID: "deleteBaseDashboard",
			Summary: "Delete a Base BI dashboard",
			Desc:    "Removes the specified dashboard from the Base.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Dashboard deleted"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/views", Tag: "Bases", OpID: "addBaseView",
			Summary: "Create a Base view (grid, kanban, gallery, calendar, gantt, form)",
			Desc:    "Adds a new named view over a Base table.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Kanban Board"}, "type": {Type: "string", Example: "kanban"}, "tableId": {Type: "integer"}}, "name", "type"), "View creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("View created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/account-views", Tag: "Bases", OpID: "addBaseViewForAccount",
			Summary: "Create a Base view with account guard",
			Desc:    "Creates a new Base view while asserting the caller's expected account header.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "type": {Type: "string"}}, "name", "type"), "Account-guarded view payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("View created", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/views/{vid}/duplicate", Tag: "Bases", OpID: "duplicateBaseView",
			Summary: "Duplicate a Base view",
			Desc:    "Clones a view's filters, sorts, groupings, and visible fields into a new view.",
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("View duplicated", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/views/{vid}/rename", Tag: "Bases", OpID: "renameBaseView",
			Summary: "Rename a Base view",
			Desc:    "Updates the title of an existing Base view.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}}, "name"), "View rename payload"),
			Resps:   oaStdResp("200", "View renamed", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/views/reorder", Tag: "Bases", OpID: "reorderBaseViews",
			Summary: "Reorder Base views",
			Desc:    "Updates the tab display order of views within a Base table.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"viewIds": {Type: "array", ItemsType: "integer"}}, "viewIds"), "Ordered view IDs"),
			Resps:   oaStdResp("200", "Views reordered", "", false),
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/views/{vid}", Tag: "Bases", OpID: "patchBaseView",
			Summary: "Update Base view filters, sorts, grouping, or layout config",
			Desc:    "Updates view settings and persisted layout configuration.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "config": {Type: "object"}}), "View patch payload"),
			Resps:   oaStdResp("200", "View updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/views/{vid}", Tag: "Bases", OpID: "deleteBaseView",
			Summary: "Delete a Base view",
			Desc:    "Deletes a non-last view from the Base.",
			Resps:   map[string]oaResp{"204": oaPlainResp("View deleted"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/bases/{id}/views/{vid}/public-form", Tag: "Bases", OpID: "getBasePublicFormStatus",
			Summary: "Get public form publishing status for a view",
			Desc:    "Returns whether anonymous public form submission is enabled and its share token.",
			Resps:   oaStdResp("200", "Public form status", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/views/{vid}/public-form", Tag: "Bases", OpID: "publishBasePublicForm",
			Summary: "Publish a Base form view for external submissions",
			Desc:    "Enables an anonymous public submission URL for the form view.",
			Resps:   oaStdResp("200", "Public form published", "", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/views/{vid}/public-form", Tag: "Bases", OpID: "closeBasePublicForm",
			Summary: "Close a published Base public form",
			Desc:    "Revokes anonymous submissions on the form view.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Public form closed"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/views/{vid}/form-config", Tag: "Bases", OpID: "saveBasePublicFormConfig",
			Summary: "Save form view field configuration",
			Desc:    "Configures visible fields, required flags, and descriptions for a Base form view.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"config": {Type: "object"}}), "Form config payload"),
			Resps:   oaStdResp("200", "Form configuration saved", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/query", Tag: "Bases", OpID: "queryBase",
			Summary: "Query Base records with filter, sort, and grouping",
			Desc:    "Executes a structured query over Base records with filter predicates and sorting.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"viewId": {Type: "integer", Description: "Optional view ID"},
				"filter": {Type: "object", Description: "Filter predicate tree"},
				"sort":   {Type: "array", ItemsType: "object", Description: "Sort clauses"},
			}), "Base query specification"),
			Resps: oaStdResp("200", "Matched records", "BaseRecord", true),
		},
		{
			Method: "GET", Path: "/api/bases/{id}/automations", Tag: "Bases", OpID: "listBaseAutomations",
			Summary: "List Base automation rules",
			Desc:    "Lists trigger-action automation workflows configured on the Base.",
			Resps:   oaStdResp("200", "Automation rules", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/automations", Tag: "Bases", OpID: "createBaseAutomation",
			Summary: "Create a Base automation rule",
			Desc:    "Adds a new trigger-action automation rule (e.g., record created -> notify or call webhook).",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name":    {Type: "string", Example: "Notify on High Priority"},
				"trigger": {Type: "object"},
				"actions": {Type: "array", ItemsType: "object"},
			}, "name", "trigger", "actions"), "Automation rule payload"),
			Resps: map[string]oaResp{"201": oaJSONInlineResp("Automation created", map[string]any{"type": "object"}), "403": oaErrResp("Manage access required")},
		},
		{
			Method: "PATCH", Path: "/api/bases/{id}/automations/{aid}", Tag: "Bases", OpID: "patchBaseAutomation",
			Summary: "Update a Base automation rule",
			Desc:    "Updates an existing automation's trigger, actions, or enabled state.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "enabled": {Type: "boolean"}, "trigger": {Type: "object"}, "actions": {Type: "array", ItemsType: "object"}}), "Automation update payload"),
			Resps:   oaStdResp("200", "Automation updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/bases/{id}/automations/{aid}", Tag: "Bases", OpID: "deleteBaseAutomation",
			Summary: "Delete a Base automation rule",
			Desc:    "Deletes an automation rule from the Base.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Automation deleted"), "403": oaErrResp("Manage access required")},
		},
		{
			Method: "POST", Path: "/api/bases/{id}/import", Tag: "Bases", OpID: "importBaseCSV",
			Summary: "Import CSV data into a Base",
			Desc:    "Parses CSV content and creates columns/records inside the Base.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"csv": {Type: "string"}}, "csv"), "CSV import payload"),
			Resps:   oaStdResp("200", "CSV imported", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/import-records", Tag: "Bases", OpID: "importBaseRecords",
			Summary: "Import structured records into a Base table",
			Desc:    "Bulk-imports typed rows with optional schema mapping into the Base.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"tableId": {Type: "integer"}, "rows": {Type: "array", ItemsType: "object"}}, "rows"), "Structured records payload"),
			Resps:   oaStdResp("200", "Records imported", "BaseRecord", true),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/ai-import-preview", Tag: "Bases", OpID: "previewBaseAIImport",
			Summary: "Preview AI-extracted Base records from text",
			Desc:    "Uses configured AI to parse unstructured text into proposed Base columns and rows.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"text": {Type: "string"}}, "text"), "Text extraction input"),
			Resps:   oaStdResp("200", "Proposed records preview", "", false),
		},
		{
			Method: "POST", Path: "/api/bases/{id}/ai-image-import-preview", Tag: "Bases", OpID: "previewBaseAIImageImport",
			Summary: "Preview AI-extracted Base records from an image",
			Desc:    "Uses multimodal AI to extract table rows from an uploaded screenshot or photo.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"image": {Type: "string", Description: "Data URL or base64 image"}}, "image"), "Image extraction input"),
			Resps:   oaStdResp("200", "Proposed records preview", "", false),
		},
		{
			Method: "GET", Path: "/api/bases/{id}/export", Tag: "Bases", OpID: "exportBaseCSV",
			Summary: "Export Base records as CSV",
			Desc:    "Downloads visible Base records formatted as formula-safe CSV.",
			Resps:   map[string]oaResp{"200": oaTextResp("CSV export", "text/csv"), "403": oaErrResp("Download access required")},
		},
	}
}

func oaOpsSlides() []oaRoute {
	return []oaRoute{
		{
			Method: "POST", Path: "/api/slides/{id}/images", Tag: "Slides", OpID: "uploadSlidesImage",
			Summary: "Upload an image asset into a slides deck",
			Desc:    "Uploads an image for placement on slide canvas pages.",
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Uploaded image metadata", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/account-title", Tag: "Slides", OpID: "renameSlidesForAccount",
			Summary: "Rename a slides deck with account guard",
			Desc:    "Updates the presentation title while verifying the caller's expected account header.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}}, "title"), "Deck title payload"),
			Resps:   oaStdResp("200", "Deck renamed", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/import-pptx", Tag: "Slides", OpID: "importSlidesPptx",
			Summary: "Import PPTX slides into a presentation deck",
			Desc:    "Imports parsed PowerPoint slides, layouts, and shapes into the deck.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"pages": {Type: "array", ItemsType: "object"}}), "PPTX import payload"),
			Resps:   oaStdResp("200", "Slides imported", "SlidesDeck", false),
		},
		{
			Method: "GET", Path: "/api/slides/{id}/pages", Tag: "Slides", OpID: "listSlidesPages",
			Summary: "List slides deck pages",
			Desc:    "Returns ordered slide pages, elements, layouts, and themes for a presentation deck.",
			Resps:   oaStdResp("200", "Slide deck pages", "SlidesDeck", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages", Tag: "Slides", OpID: "createSlidesPage",
			Summary: "Append a new slide page",
			Desc:    "Creates a new slide page inside the deck.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string", Example: "Architecture Overview"}, "layout": {Type: "string", Example: "title_and_body"}}), "New slide page payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Slide page created", "SlidesPage"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/insert", Tag: "Slides", OpID: "insertSlidesPage",
			Summary: "Insert a slide page after an anchor page",
			Desc:    "Atomically inserts a new slide page with optional preset layout after a verified anchor revision.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"afterPageId": {Type: "integer"}, "expectedRevision": {Type: "integer"}, "layout": {Type: "string"}}), "Insert slide payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Slide page inserted", "SlidesPage"), "409": oaErrResp("Anchor revision conflict")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/restore", Tag: "Slides", OpID: "restoreSlidesPage",
			Summary: "Restore a recently deleted slide page",
			Desc:    "Re-inserts a deleted slide page (undo delete).",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"page": {Type: "object"}}), "Restore slide payload"),
			Resps:   oaStdResp("200", "Slide page restored", "SlidesPage", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/paste", Tag: "Slides", OpID: "pasteSlidesPage",
			Summary: "Paste a copied slide page within the same deck",
			Desc:    "Creates a new slide page cloned from an internal clipboard snapshot.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"afterPageId": {Type: "integer"}, "page": {Type: "object"}}), "Paste slide payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Slide page pasted", "SlidesPage"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/paste-from", Tag: "Slides", OpID: "pasteSlidesPageFrom",
			Summary: "Paste a slide page from another presentation deck",
			Desc:    "Copies a slide page and its embedded media assets across presentation decks.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"sourceSlidesId": {Type: "integer"}, "sourcePageId": {Type: "integer"}, "afterPageId": {Type: "integer"}}), "Cross-deck paste payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Slide page pasted", "SlidesPage"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/reorder", Tag: "Slides", OpID: "reorderSlidesPages",
			Summary: "Reorder pages inside a presentation deck",
			Desc:    "Updates the exact slide ordering across the deck.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"pageIds": {Type: "array", ItemsType: "integer"}}, "pageIds"), "Ordered page IDs"),
			Resps:   oaStdResp("200", "Deck reordered", "SlidesDeck", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/{pid}/duplicate", Tag: "Slides", OpID: "duplicateSlidesPage",
			Summary: "Duplicate a slide page",
			Desc:    "Clones the specified slide page immediately after itself.",
			Resps:   map[string]oaResp{"201": oaJSONResp("Slide page duplicated", "SlidesPage"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages/{pid}/delete", Tag: "Slides", OpID: "deleteSlidesPageVersioned",
			Summary: "Delete a slide page with revision check",
			Desc:    "Deletes a slide page while enforcing optimistic revision concurrency.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"expectedRevision": {Type: "integer"}}), "Delete guard payload"),
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Slide page deleted", map[string]any{"type": "object"}), "409": oaErrResp("Revision conflict")},
		},
		{
			Method: "PATCH", Path: "/api/slides/{id}/pages/{pid}/visibility", Tag: "Slides", OpID: "setSlidesPageVisibility",
			Summary: "Show or hide a slide page during presentation",
			Desc:    "Toggles whether the slide is skipped in presentation mode.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"hidden": {Type: "boolean"}}, "hidden"), "Slide visibility payload"),
			Resps:   oaStdResp("200", "Visibility updated", "SlidesPage", false),
		},
		{
			Method: "PATCH", Path: "/api/slides/{id}/pages/{pid}/content", Tag: "Slides", OpID: "patchSlidesPageContent",
			Summary: "Update slide page canvas content",
			Desc:    "Updates vector elements, text boxes, shapes, speaker notes, and animations on a slide page.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"shapes": {Type: "array", ItemsType: "object"}, "title": {Type: "string"}, "notes": {Type: "string"}}), "Slide canvas patch"),
			Resps:   oaStdResp("200", "Slide page updated", "SlidesPage", false),
		},
		{
			Method: "PATCH", Path: "/api/slides/{id}/pages/{pid}/meta", Tag: "Slides", OpID: "patchSlidesPageMeta",
			Summary: "Update slide page transition and metadata",
			Desc:    "Updates per-slide metadata such as transitions, theme overrides, and layout attributes.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"meta": {Type: "object"}}), "Slide meta patch"),
			Resps:   oaStdResp("200", "Slide meta updated", "SlidesPage", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/pages-meta", Tag: "Slides", OpID: "batchPatchSlidesPagesMeta",
			Summary: "Batch update metadata across multiple slide pages",
			Desc:    "Applies transition or theme metadata changes across selected slide pages atomically.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"updates": {Type: "array", ItemsType: "object"}}), "Batch slide meta updates"),
			Resps:   oaStdResp("200", "Slide metadata updated", "SlidesDeck", false),
		},
		{
			Method: "PATCH", Path: "/api/slides/pages/{pid}", Tag: "Slides", OpID: "patchSlidesPage",
			Summary: "Update a slide page by page ID",
			Desc:    "Legacy/direct update of a slide page's title, body, background, or shapes.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}, "body": {Type: "string"}, "background": {Type: "string"}}), "Slide page update"),
			Resps:   oaStdResp("200", "Slide page updated", "SlidesPage", false),
		},
		{
			Method: "DELETE", Path: "/api/slides/pages/{pid}", Tag: "Slides", OpID: "deleteSlidesPage",
			Summary: "Delete a slide page by page ID",
			Desc:    "Removes the specified slide page from its deck.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Slide page deleted"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/slides/pages/{pid}/move", Tag: "Slides", OpID: "moveSlidesPage",
			Summary: "Move a slide page to a new position",
			Desc:    "Moves a slide page to a specific fractional position inside its deck.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"pos": {Type: "number"}}), "Slide position payload"),
			Resps:   oaStdResp("200", "Slide page moved", "SlidesPage", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/background-all", Tag: "Slides", OpID: "applySlidesBackgroundAll",
			Summary: "Apply a uniform background to all pages in a deck",
			Desc:    "Sets the same background color or gradient across every page in the presentation.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"background": {Type: "string"}}, "background"), "Deck background payload"),
			Resps:   oaStdResp("200", "Background applied", "SlidesDeck", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/background-changes", Tag: "Slides", OpID: "applySlidesBackgroundChanges",
			Summary: "Apply per-page background changes atomically",
			Desc:    "Updates backgrounds for a specified subset of pages in a single operation.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"changes": {Type: "array", ItemsType: "object"}}), "Background changes payload"),
			Resps:   oaStdResp("200", "Background changes applied", "SlidesDeck", false),
		},
		{
			Method: "GET", Path: "/api/slides/{id}/comments", Tag: "Slides", OpID: "listSlidesComments",
			Summary: "List comments on a slides deck",
			Desc:    "Returns comments anchored to slide pages and canvas coordinates.",
			Resps:   oaStdResp("200", "Slides comments", "Comment", true),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/comments", Tag: "Slides", OpID: "createSlidesComment",
			Summary: "Add a comment to a slide page",
			Desc:    "Creates a new slide comment anchored to a page and optional coordinate.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"pageId": {Type: "integer"}, "body": {Type: "string"}}, "body"), "Slides comment payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Comment created", "Comment"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "PATCH", Path: "/api/slides/{id}/comments/{cid}", Tag: "Slides", OpID: "patchSlidesComment",
			Summary: "Update or resolve a slide comment",
			Desc:    "Edits the text or resolved status of a slide comment.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"body": {Type: "string"}, "resolved": {Type: "boolean"}}), "Slide comment patch"),
			Resps:   oaStdResp("200", "Comment updated", "Comment", false),
		},
		{
			Method: "DELETE", Path: "/api/slides/{id}/comments/{cid}", Tag: "Slides", OpID: "deleteSlidesComment",
			Summary: "Delete a slide comment",
			Desc:    "Deletes the specified comment on a slide deck.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Comment deleted"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/slides/{id}/versions", Tag: "Slides", OpID: "listSlidesVersions",
			Summary: "List slide deck version snapshots",
			Desc:    "Returns saved version history snapshots of a presentation.",
			Resps:   oaStdResp("200", "Deck versions", "", false),
		},
		{
			Method: "POST", Path: "/api/slides/{id}/versions", Tag: "Slides", OpID: "createSlidesVersion",
			Summary: "Create a slide deck version snapshot",
			Desc:    "Captures a named snapshot of all slides in the presentation.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"label": {Type: "string", Example: "Board Review Final"}}), "Deck version label"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Deck version created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/slides/{id}/versions/{vid}/restore", Tag: "Slides", OpID: "restoreSlidesVersion",
			Summary: "Restore a slide deck version snapshot",
			Desc:    "Restores all slide pages in the presentation from a saved version.",
			Resps:   oaStdResp("200", "Deck restored", "SlidesDeck", false),
		},
	}
}

func oaOpsDrive() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/api/drive/children", Tag: "Drive", OpID: "listDriveChildren",
			Summary: "List folder children in Drive",
			Desc:    "Lists folders and documents inside a workspace root or nested folder.",
			Params: []map[string]any{
				oaQueryParam("workspaceId", "integer", "Workspace ID", true),
				oaQueryParam("parentId", "integer", "Optional parent folder ID (omit for root)", false),
			},
			Resps: oaStdResp("200", "Child nodes", "DocMeta", true),
		},
		{
			Method: "POST", Path: "/api/drive/folders", Tag: "Drive", OpID: "createDriveFolder",
			Summary: "Create a Drive folder",
			Desc:    "Creates a folder in the specified workspace and optional parent folder.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"workspaceId": {Type: "integer", Example: 1},
				"parentId":    {Type: "integer"},
				"title":       {Type: "string", Example: "Engineering Specs"},
			}, "workspaceId", "title"), "Folder creation payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Folder created", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/nodes", Tag: "Drive", OpID: "createDriveNode",
			Summary: "Create a Drive node (doc, sheet, base, slides, folder)",
			Desc:    "Creates a new node under a Drive folder with optional initial content.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"workspaceId": {Type: "integer"}, "parentId": {Type: "integer"}, "kind": {Type: "string"}, "title": {Type: "string"}}, "workspaceId", "title"), "Drive node creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Node created", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/word-import-nodes", Tag: "Drive", OpID: "createDriveWordImportNode",
			Summary: "Create a document node from imported Word (.docx) content",
			Desc:    "Creates a Drive document initialized with converted Word document blocks.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"workspaceId": {Type: "integer"}, "title": {Type: "string"}, "blocks": {Type: "array", ItemsType: "object"}}), "Word import payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Imported document created", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/files", Tag: "Drive", OpID: "uploadDriveFile",
			Summary: "Upload a standalone file to Drive",
			Desc:    "Uploads a binary file node into a workspace Drive folder.",
			Resps:   map[string]oaResp{"201": oaJSONResp("Drive file uploaded", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/batch/files", Tag: "Drive", OpID: "batchUploadDriveFiles",
			Summary: "Batch upload files into Drive",
			Desc:    "Uploads multiple files into a Drive folder hierarchy in a batch flow.",
			Resps:   map[string]oaResp{"201": oaJSONArrayResp("Uploaded file nodes", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/batch/folders", Tag: "Drive", OpID: "batchCreateDriveFolders",
			Summary: "Batch create nested Drive folders",
			Desc:    "Creates a nested folder tree in Drive during folder upload.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"workspaceId": {Type: "integer"}, "parentId": {Type: "integer"}, "paths": {Type: "array", ItemsType: "string"}}), "Batch folder paths"),
			Resps:   map[string]oaResp{"201": oaJSONArrayResp("Created folder nodes", "DocMeta"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/drive/files/{id}", Tag: "Drive", OpID: "downloadDriveFile",
			Summary: "Download a Drive file node",
			Desc:    "Streams the binary content of a standalone uploaded Drive file.",
			Resps:   map[string]oaResp{"200": oaBinaryResp("Drive file content"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Not found")},
		},
		{
			Method: "GET", Path: "/api/drive/shortcuts", Tag: "Drive", OpID: "listDriveShortcuts",
			Summary: "List Drive shortcuts in a workspace",
			Desc:    "Returns Drive shortcut links pointing to documents or folders.",
			Params:  []map[string]any{oaQueryParam("workspaceId", "integer", "Workspace ID", true)},
			Resps:   oaStdResp("200", "Drive shortcuts", "", false),
		},
		{
			Method: "POST", Path: "/api/drive/shortcuts", Tag: "Drive", OpID: "createDriveShortcut",
			Summary: "Create a Drive shortcut",
			Desc:    "Adds a shortcut reference to an accessible target node inside a Drive folder.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"workspaceId": {Type: "integer"}, "parentId": {Type: "integer"}, "targetId": {Type: "integer"}}, "workspaceId", "targetId"), "Shortcut creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Shortcut created", map[string]any{"type": "object"}), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "DELETE", Path: "/api/drive/shortcuts/{sid}", Tag: "Drive", OpID: "deleteDriveShortcut",
			Summary: "Delete a Drive shortcut",
			Desc:    "Removes a Drive shortcut without affecting its target document.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Shortcut deleted"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/move/{id}", Tag: "Drive", OpID: "moveDriveNode",
			Summary: "Move a Drive node within the same workspace",
			Desc:    "Reparents a folder or document to another folder within the same workspace.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"parentId": {Type: "integer", Description: "Destination parent folder ID (null for root)"}}), "Move target payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Node moved", "DocMeta"), "403": oaErrResp("Forbidden"), "409": oaErrResp("Cycle or revision conflict")},
		},
		{
			Method: "POST", Path: "/api/drive/account-move/{id}", Tag: "Drive", OpID: "accountMoveDriveNode",
			Summary: "Move a Drive node with account guard",
			Desc:    "Reparents a Drive node while verifying the caller's expected account header.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"parentId": {Type: "integer"}}), "Account-guarded move payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Node moved", "DocMeta"), "409": oaErrResp("Cycle or revision conflict")},
		},
		{
			Method: "POST", Path: "/api/drive/cross-space-move/{id}", Tag: "Drive", OpID: "crossSpaceMoveDriveNode",
			Summary: "Move a Drive node or folder across workspaces",
			Desc:    "Atomically moves a document or entire folder subtree to another workspace and updates visibility & audit logs.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"targetWorkspaceId": {Type: "integer", Example: 2},
				"targetParentId":    {Type: "integer"},
			}, "targetWorkspaceId"), "Cross-space move target"),
			Resps: map[string]oaResp{"200": oaJSONResp("Node moved across workspaces", "DocMeta"), "403": oaErrResp("Insufficient permissions"), "409": oaErrResp("Cycle or conflict")},
		},
		{
			Method: "POST", Path: "/api/drive/trash/{id}", Tag: "Drive", OpID: "trashDriveNode",
			Summary: "Move a Drive node to trash",
			Desc:    "Soft-deletes a document or folder subtree into trash.",
			Resps:   oaStdResp("200", "Node trashed", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/drive/account-trash/{id}", Tag: "Drive", OpID: "accountTrashDriveNode",
			Summary: "Trash a Drive node with account guard",
			Desc:    "Soft-deletes a Drive node while verifying the caller's expected account header.",
			Resps:   oaStdResp("200", "Node trashed", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/drive/restore/{id}", Tag: "Drive", OpID: "restoreDriveNode",
			Summary: "Restore a trashed Drive node",
			Desc:    "Restores a previously trashed document or folder subtree.",
			Resps:   oaStdResp("200", "Node restored", "DocMeta", false),
		},
		{
			Method: "POST", Path: "/api/drive/purge/{id}", Tag: "Drive", OpID: "purgeDriveNode",
			Summary: "Permanently purge a trashed Drive node",
			Desc:    "Irreversibly removes a trashed document or folder subtree from storage.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Node permanently purged"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "POST", Path: "/api/drive/rename/{id}", Tag: "Drive", OpID: "renameDriveNode",
			Summary: "Rename a Drive node",
			Desc:    "Updates the title of a folder, file, or document in Drive.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}}, "title"), "Rename payload"),
			Resps:   oaStdResp("200", "Node renamed", "DocMeta", false),
		},
	}
}

func oaOpsWikiAndSurveys() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/wiki-spaces", Tag: "Wiki", OpID: "listWikiSpaces",
			Summary: "List Wiki knowledge spaces in a workspace",
			Desc:    "Returns accessible Wiki spaces and caller roles inside the workspace.",
			Resps:   oaStdResp("200", "Wiki spaces", "WikiSpace", true),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/wiki-spaces", Tag: "Wiki", OpID: "createWikiSpace",
			Summary: "Create a Wiki knowledge space",
			Desc:    "Creates an independent Wiki space with workspace-wide or private visibility.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name":        {Type: "string", Example: "Engineering Handbook"},
				"description": {Type: "string"},
				"icon":        {Type: "string", Example: "📚"},
				"visibility":  {Type: "string", Enum: []string{"workspace", "private"}, Example: "workspace"},
			}, "name"), "Wiki space creation payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Wiki space created", "WikiSpace"), "403": oaErrResp("Forbidden")},
		},
		{
			Method: "GET", Path: "/api/wiki/spaces/{spaceId}", Tag: "Wiki", OpID: "getWikiSpace",
			Summary: "Get Wiki space details, node tree, and grants",
			Desc:    "Returns full Wiki space metadata, hierarchical page tree, and permission grants.",
			Resps:   map[string]oaResp{"200": oaJSONResp("Wiki space detail", "WikiSpace"), "403": oaErrResp("Forbidden"), "404": oaErrResp("Wiki space not found")},
		},
		{
			Method: "PATCH", Path: "/api/wiki/spaces/{spaceId}", Tag: "Wiki", OpID: "patchWikiSpace",
			Summary: "Update a Wiki space",
			Desc:    "Updates Wiki space name, description, icon, or visibility policy.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "description": {Type: "string"}, "icon": {Type: "string"}, "visibility": {Type: "string", Enum: []string{"workspace", "private"}}}), "Wiki space update payload"),
			Resps:   oaStdResp("200", "Wiki space updated", "WikiSpace", false),
		},
		{
			Method: "DELETE", Path: "/api/wiki/spaces/{spaceId}", Tag: "Wiki", OpID: "deleteWikiSpace",
			Summary: "Delete a Wiki space",
			Desc:    "Deletes the Wiki space and its internal hierarchy.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Wiki space deleted"), "403": oaErrResp("Manage access required")},
		},
		{
			Method: "PUT", Path: "/api/wiki/spaces/{spaceId}/grants", Tag: "Wiki", OpID: "putWikiSpaceGrant",
			Summary: "Set user, department, or group permission on a Wiki space",
			Desc:    "Grants, updates, or revokes a subject's role (`view`, `edit`, `manage`) across the Wiki space.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"subjectType": {Type: "string", Enum: []string{"user", "department", "group"}},
				"subjectId":   {Type: "integer"},
				"role":        {Type: "string", Enum: []string{"view", "edit", "manage", ""}},
			}, "subjectType", "subjectId", "role"), "Wiki space grant payload"),
			Resps: oaStdResp("200", "Wiki grants updated", "", false),
		},
		{
			Method: "POST", Path: "/api/wiki/spaces/{spaceId}/nodes", Tag: "Wiki", OpID: "createWikiNode",
			Summary: "Create a page or node inside a Wiki space",
			Desc:    "Creates a collaborative document, sheet, base, or slides node inside the Wiki tree.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}, "kind": {Type: "string"}, "parentId": {Type: "integer"}}, "title"), "Wiki node payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Wiki node created", "DocMeta"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/wiki/spaces/{spaceId}/nodes/{id}/reorder", Tag: "Wiki", OpID: "reorderWikiNode",
			Summary: "Reorder a node inside a Wiki space tree",
			Desc:    "Reparents or changes sibling sort order of a Wiki node.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"parentId": {Type: "integer"}, "sortOrder": {Type: "integer"}}), "Wiki reorder payload"),
			Resps:   oaStdResp("200", "Wiki node reordered", "", false),
		},
		{
			Method: "POST", Path: "/api/wiki/spaces/{spaceId}/import-drive", Tag: "Wiki", OpID: "importDriveIntoWiki",
			Summary: "Move or import Drive nodes into a Wiki space",
			Desc:    "Imports existing workspace Drive documents into the Wiki space hierarchy.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"docIds": {Type: "array", ItemsType: "integer"}, "parentId": {Type: "integer"}}, "docIds"), "Drive import payload"),
			Resps:   oaStdResp("200", "Drive nodes imported", "", false),
		},
		{
			Method: "POST", Path: "/api/wiki/spaces/{spaceId}/shortcuts", Tag: "Wiki", OpID: "createWikiShortcut",
			Summary: "Add a shortcut inside a Wiki space",
			Desc:    "Places a shortcut entry referencing another accessible document inside the Wiki tree.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"targetId": {Type: "integer"}, "parentId": {Type: "integer"}}, "targetId"), "Wiki shortcut payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Wiki shortcut created", map[string]any{"type": "object"}), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "DELETE", Path: "/api/wiki/spaces/{spaceId}/shortcuts/{sid}", Tag: "Wiki", OpID: "deleteWikiShortcut",
			Summary: "Remove a shortcut from a Wiki space",
			Desc:    "Deletes a shortcut from the Wiki tree without modifying the target node.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Wiki shortcut deleted"), "403": oaErrResp("Edit access required")},
		},
		{
			Method: "POST", Path: "/api/wiki/nodes/{id}/move", Tag: "Wiki", OpID: "moveWikiNode",
			Summary: "Move a Wiki node across spaces or back to Drive",
			Desc:    "Moves a Wiki node to another Wiki space or parent node.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"targetSpaceId": {Type: "integer"}, "targetParentId": {Type: "integer"}}), "Wiki move payload"),
			Resps:   oaStdResp("200", "Wiki node moved", "", false),
		},
		// Surveys & Public
		{
			Method: "GET", Path: "/api/surveys/{id}", Tag: "Surveys & Public", OpID: "getSurvey",
			Summary: "Get survey schema and configuration",
			Desc:    "Returns survey questions, status, and publishing metadata.",
			Resps:   oaStdResp("200", "Survey definition", "", false),
		},
		{
			Method: "PUT", Path: "/api/surveys/{id}", Tag: "Surveys & Public", OpID: "saveSurvey",
			Summary: "Save survey questions and settings",
			Desc:    "Replaces the survey definition, fields, and completion message.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"title": {Type: "string"}, "questions": {Type: "array", ItemsType: "object"}}), "Survey definition payload"),
			Resps:   oaStdResp("200", "Survey saved", "", false),
		},
		{
			Method: "POST", Path: "/api/surveys/{id}/status", Tag: "Surveys & Public", OpID: "setSurveyStatus",
			Summary: "Publish or close a survey",
			Desc:    "Transitions a survey between draft, published, and closed states.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"status": {Type: "string", Enum: []string{"draft", "published", "closed"}}}, "status"), "Survey status payload"),
			Resps:   oaStdResp("200", "Survey status updated", "", false),
		},
		{
			Method: "GET", Path: "/api/surveys/{id}/stats", Tag: "Surveys & Public", OpID: "getSurveyStats",
			Summary: "Get aggregated survey response statistics",
			Desc:    "Returns response counts, per-question distributions, and individual submissions.",
			Resps:   oaStdResp("200", "Survey statistics", "", false),
		},
		{
			Method: "GET", Path: "/api/public/surveys/{token}", Tag: "Surveys & Public", OpID: "getPublicSurvey",
			Summary: "Get a published public survey",
			Desc:    "Returns anonymous-safe survey questions for a published survey link token.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Public survey", map[string]any{"type": "object"}), "404": oaErrResp("Survey not found")},
			Public:  true,
		},
		{
			Method: "POST", Path: "/api/public/surveys/{token}/submit", Tag: "Surveys & Public", OpID: "submitPublicSurvey",
			Summary: "Submit an anonymous response to a public survey",
			Desc:    "Validates and records a respondent's answers to a published survey.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"answers": {Type: "object"}}, "answers"), "Survey response answers"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Response submitted", map[string]any{"type": "object"}), "400": oaErrResp("Invalid answers"), "404": oaErrResp("Survey closed or not found")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/public/{token}", Tag: "Surveys & Public", OpID: "getPublicDoc",
			Summary: "Access a publicly shared document by link token",
			Desc:    "Returns read-only content for a public link (or password challenge when password-protected).",
			Resps:   map[string]oaResp{"200": oaJSONResp("Public document snapshot", "DocMeta"), "401": oaErrResp("Link password required"), "404": oaErrResp("Share link not found")},
			Public:  true,
		},
		{
			Method: "POST", Path: "/api/public/{token}/verify-password", Tag: "Surveys & Public", OpID: "verifyPublicLinkPassword",
			Summary: "Verify password for a protected public share link",
			Desc:    "Validates the link password and sets a scoped verification cookie.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"password": {Type: "string"}}, "password"), "Share link password"),
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Password verified", map[string]any{"type": "object"}), "401": oaErrResp("Incorrect password")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/public/{token}/cover/image", Tag: "Surveys & Public", OpID: "getPublicCoverImage",
			Summary: "Download cover image for a public shared document",
			Desc:    "Streams the cover image asset for a publicly shared document.",
			Resps:   map[string]oaResp{"200": oaBinaryResp("Cover image"), "404": oaErrResp("Not found")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/public/{token}/files/{id}", Tag: "Surveys & Public", OpID: "getPublicDocFile",
			Summary: "Download an attachment from a public shared document",
			Desc:    "Streams an attachment embedded inside a publicly shared document.",
			Resps:   map[string]oaResp{"200": oaBinaryResp("Attachment binary"), "404": oaErrResp("Not found")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/forms/{id}/{vid}", Tag: "Surveys & Public", OpID: "getLegacyPublicForm",
			Summary: "Legacy Base public form lookup",
			Desc:    "Returns form metadata or deprecation error for legacy ID/view public form links.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Form definition", map[string]any{"type": "object"}), "410": oaErrResp("Legacy form URL replaced by token URL")},
			Public:  true,
		},
		{
			Method: "POST", Path: "/api/forms/{id}/{vid}", Tag: "Surveys & Public", OpID: "submitLegacyPublicForm",
			Summary: "Legacy Base public form submission",
			Desc:    "Handles legacy ID/view public form submission endpoint.",
			Resps:   map[string]oaResp{"201": oaJSONResp("Record created", "BaseRecord"), "410": oaErrResp("Legacy form URL replaced by token URL")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/api/forms/{token}", Tag: "Surveys & Public", OpID: "getPublicBaseForm",
			Summary: "Get a published Base public form schema",
			Desc:    "Returns the visible fields and instructions for an external Base form link.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Public form schema", map[string]any{"type": "object"}), "404": oaErrResp("Form not found")},
			Public:  true,
		},
		{
			Method: "POST", Path: "/api/forms/{token}", Tag: "Surveys & Public", OpID: "submitPublicBaseForm",
			Summary: "Submit an external record to a published Base form",
			Desc:    "Creates a new Base record from anonymous visitor form submission.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"cells": {Type: "object"}}, "cells"), "Form field values"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Submission recorded", "BaseRecord"), "400": oaErrResp("Validation error"), "404": oaErrResp("Form closed")},
			Public:  true,
		},
	}
}

func oaOpsAI() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/api/me/ai", Tag: "AI Suite", OpID: "getAISettings",
			Summary: "Get personal AI provider settings",
			Desc:    "Returns configured LLM provider endpoint, model name, and masked API key indicator.",
			Resps:   oaStdResp("200", "AI configuration", "", false),
		},
		{
			Method: "PUT", Path: "/api/me/ai", Tag: "AI Suite", OpID: "putAISettings",
			Summary: "Save personal AI provider settings",
			Desc:    "Encrypts (AES-256-GCM) and stores the caller's OpenAI-compatible or Anthropic provider base URL, model, and API key.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"baseUrl": {Type: "string", Example: "https://api.openai.com/v1"},
				"model":   {Type: "string", Example: "gpt-4o-mini"},
				"apiKey":  {Type: "string", Description: "Provider API key (stored encrypted)"},
			}, "baseUrl", "model"), "AI provider settings"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("Settings saved", map[string]any{"type": "object"}), "400": oaErrResp("Invalid settings")},
		},
		{
			Method: "DELETE", Path: "/api/me/ai", Tag: "AI Suite", OpID: "deleteAISettings",
			Summary: "Clear personal AI provider settings",
			Desc:    "Deletes stored AI credentials for the authenticated user.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Settings cleared"), "401": oaErrResp("Unauthorized")},
		},
		{
			Method: "POST", Path: "/api/me/ai/test", Tag: "AI Suite", OpID: "testAISettings",
			Summary: "Test personal AI provider connectivity",
			Desc:    "Performs a lightweight probe against the configured or draft LLM endpoint to verify credentials and latency.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"baseUrl": {Type: "string"}, "model": {Type: "string"}, "apiKey": {Type: "string"}}), "Optional draft AI settings"),
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Connectivity test result", map[string]any{"type": "object"}), "400": oaErrResp("Connection failed")},
		},
		{
			Method: "POST", Path: "/api/docs/{id}/ai", Tag: "AI Suite", OpID: "docAI",
			Summary: "Run AI writing assistant on a document",
			Desc:    "Streams or returns AI-assisted continuation, summarization, translation, or rewriting scoped to the document.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"action":  {Type: "string", Enum: []string{"summarize", "polish", "translate", "continue", "custom"}, Example: "summarize"},
				"prompt":  {Type: "string"},
				"context": {Type: "string"},
			}, "action"), "Document AI action request"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("AI generated response", map[string]any{"type": "object"}), "400": oaErrResp("AI not configured or invalid request"), "429": oaErrResp("Rate limit exceeded")},
		},
		{
			Method: "POST", Path: "/api/ai/ask-workspace", Tag: "AI Suite", OpID: "aiAskWorkspace",
			Summary: "Ask Workspace Knowledge Base (RAG Q&A)",
			Desc:    "Retrieves permission-filtered documents from the workspace and synthesizes a cited answer via the configured LLM.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"workspaceId": {Type: "integer", Example: 1},
				"question":    {Type: "string", Example: "What is our Q4 release schedule?"},
				"maxSources":  {Type: "integer", Example: 5},
			}, "workspaceId", "question"), "Workspace RAG query"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("Answer with cited source documents", map[string]any{"type": "object"}), "400": oaErrResp("Invalid query or AI unconfigured"), "429": oaErrResp("Rate limit exceeded")},
		},
		{
			Method: "POST", Path: "/api/ai/sheet-assist", Tag: "AI Suite", OpID: "aiSheetAssist",
			Summary: "AI Spreadsheet Formula & Data Analysis Assistant",
			Desc:    "Generates spreadsheet formulas, explains errors, or summarizes selected cell ranges.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"docId":       {Type: "integer", Example: 10},
				"worksheetId": {Type: "integer", Example: 1},
				"prompt":      {Type: "string", Example: "Calculate YoY growth rate from column B to C"},
				"range":       {Type: "string", Example: "A1:D20"},
			}, "docId", "prompt"), "Sheet AI assist request"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("Formula or analysis result", map[string]any{"type": "object"}), "400": oaErrResp("Invalid request"), "429": oaErrResp("Rate limit exceeded")},
		},
		{
			Method: "POST", Path: "/api/ai/base-fill", Tag: "AI Suite", OpID: "aiBaseFill",
			Summary: "AI Base Field Autofill",
			Desc:    "Extracts structured tags, summaries, or classifications into a target Base field across selected records.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"baseId":        {Type: "integer", Example: 12},
				"targetFieldId": {Type: "integer", Example: 4},
				"recordIds":     {Type: "array", ItemsType: "integer"},
				"instruction":   {Type: "string", Example: "Classify priority as High, Medium, or Low"},
			}, "baseId", "targetFieldId", "instruction"), "Base AI autofill request"),
			Resps: map[string]oaResp{"200": oaJSONInlineResp("Proposed or applied field values", map[string]any{"type": "object"}), "400": oaErrResp("Invalid request"), "429": oaErrResp("Rate limit exceeded")},
		},
	}
}

func oaOpsOrgAndWorkspaces() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/api/workspaces", Tag: "Organization", OpID: "listMyWorkspaces",
			Summary: "List workspaces the caller belongs to",
			Desc:    "Returns all workspaces where the authenticated user is owner, admin, or member.",
			Resps:   oaStdResp("200", "Workspace list", "Workspace", true),
		},
		{
			Method: "POST", Path: "/api/workspaces", Tag: "Organization", OpID: "createWorkspace",
			Summary: "Create a new workspace",
			Desc:    "Creates a new workspace owned by the authenticated user.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Product Design"}}, "name"), "Workspace creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONResp("Workspace created", "Workspace"), "400": oaErrResp("Invalid workspace name"), "409": oaErrResp("Owned workspace limit reached")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}", Tag: "Organization", OpID: "renameWorkspace",
			Summary: "Rename a workspace",
			Desc:    "Updates the workspace display name (requires workspace owner or admin role).",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Platform Engineering"}}, "name"), "Workspace rename payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Workspace updated", "Workspace"), "400": oaErrResp("Invalid name"), "403": oaErrResp("Workspace admin required"), "404": oaErrResp("Workspace not found")},
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}", Tag: "Organization", OpID: "deleteWorkspace",
			Summary: "Delete a workspace",
			Desc:    "Deletes a workspace and cascades its memberships and resources (requires workspace owner role; prevents deleting the user's last remaining workspace).",
			Resps:   map[string]oaResp{"204": oaPlainResp("Workspace deleted"), "403": oaErrResp("Workspace owner required"), "409": oaErrResp("Cannot delete last workspace")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/transfer-owner", Tag: "Organization", OpID: "transferWorkspaceOwner",
			Summary: "Transfer workspace ownership to another member",
			Desc:    "Atomically transfers the `owner` role to an existing workspace member and demotes the prior owner to `admin`.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"newOwnerId": {Type: "integer", Description: "Target member user ID", Example: 2}}, "newOwnerId"), "Ownership transfer payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Ownership transferred", "Workspace"), "400": oaErrResp("Invalid target member"), "403": oaErrResp("Workspace owner required")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/leave", Tag: "Organization", OpID: "leaveWorkspace",
			Summary: "Leave a workspace",
			Desc:    "Removes the authenticated caller from a non-owned workspace and cleans up department/group memberships.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Left workspace"), "403": oaErrResp("Workspace owner must transfer ownership before leaving")},
		},
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/org", Tag: "Organization", OpID: "getWorkspaceOrg",
			Summary: "Get full workspace organization directory",
			Desc:    "Returns members, roles, hierarchical departments, user groups, and pending invitations (for admins).",
			Resps:   oaStdResp("200", "Organization snapshot", "", false),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/members", Tag: "Organization", OpID: "upsertWorkspaceMember",
			Summary: "Invite, update role, or remove a workspace member",
			Desc:    "Invites a non-member by email, updates an existing member's role (`member`/`admin`), or removes (`remove`) them.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"email": {Type: "string", Format: "email", Example: "new.hire@example.com"},
				"role":  {Type: "string", Enum: []string{"member", "admin", "remove"}, Example: "member"},
			}, "email", "role"), "Member role mutation"),
			Resps: oaStdResp("200", "Member updated, invited, or removed", "", false),
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/invitations/{inviteId}", Tag: "Organization", OpID: "revokeWorkspaceInvitation",
			Summary: "Revoke a pending workspace invitation",
			Desc:    "Cancels an unaccepted email invitation to the workspace.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Invitation revoked"), "403": oaErrResp("Workspace admin required"), "404": oaErrResp("Invitation not found")},
		},
		{
			Method: "GET", Path: "/api/invitations", Tag: "Organization", OpID: "listMyInvitations",
			Summary: "List pending workspace invitations for the caller",
			Desc:    "Returns open workspace invitations addressed to the caller's email.",
			Resps:   oaStdResp("200", "Pending invitations", "", false),
		},
		{
			Method: "POST", Path: "/api/invitations/{inviteId}/accept", Tag: "Organization", OpID: "acceptWorkspaceInvitation",
			Summary: "Accept a workspace invitation",
			Desc:    "Accepts the invitation and joins the target workspace with the invited role.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Invitation accepted", map[string]any{"type": "object"}), "404": oaErrResp("Invitation not found")},
		},
		{
			Method: "POST", Path: "/api/invitations/{inviteId}/decline", Tag: "Organization", OpID: "declineWorkspaceInvitation",
			Summary: "Decline a workspace invitation",
			Desc:    "Declines and removes a pending workspace invitation.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Invitation declined", map[string]any{"type": "object"}), "404": oaErrResp("Invitation not found")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/departments", Tag: "Organization", OpID: "createDepartment",
			Summary: "Create an organization department",
			Desc:    "Creates a top-level or nested child department inside the workspace.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Platform Engineering"}, "parentId": {Type: "integer"}, "sortOrder": {Type: "integer"}}, "name"), "Department creation payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Department created", map[string]any{"type": "object"}), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}/departments/{deptId}", Tag: "Organization", OpID: "updateDepartment",
			Summary: "Update or reparent a department",
			Desc:    "Renames, reorders, or moves a department inside the workspace org tree.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "parentId": {Type: "integer"}, "sortOrder": {Type: "integer"}}), "Department update payload"),
			Resps:   oaStdResp("200", "Department updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/departments/{deptId}", Tag: "Organization", OpID: "deleteDepartment",
			Summary: "Delete a department",
			Desc:    "Deletes an empty or sub-department node and revokes its subject-based grants.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Department deleted"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PUT", Path: "/api/workspaces/{wsId}/departments/{deptId}/members", Tag: "Organization", OpID: "setDepartmentMember",
			Summary: "Add, update leader status, or remove a department member",
			Desc:    "Updates a workspace member's membership or leader status inside a department.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"userId": {Type: "integer"}, "present": {Type: "boolean"}, "isLeader": {Type: "boolean"}}, "userId", "present"), "Department member mutation"),
			Resps:   oaStdResp("200", "Department membership updated", "", false),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/groups", Tag: "Organization", OpID: "createUserGroup",
			Summary: "Create a workspace user group",
			Desc:    "Creates an explicit user group for batch permission sharing and SCIM mapping.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string", Example: "Security Reviewers"}, "description": {Type: "string"}}, "name"), "User group payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("User group created", map[string]any{"type": "object"}), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}/groups/{groupId}", Tag: "Organization", OpID: "updateUserGroup",
			Summary: "Update a workspace user group",
			Desc:    "Renames or updates the description of an organization user group.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "description": {Type: "string"}}), "User group update payload"),
			Resps:   oaStdResp("200", "User group updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/groups/{groupId}", Tag: "Organization", OpID: "deleteUserGroup",
			Summary: "Delete a workspace user group",
			Desc:    "Deletes a user group and cleans up its subject-based document/wiki grants.",
			Resps:   map[string]oaResp{"204": oaPlainResp("User group deleted"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PUT", Path: "/api/workspaces/{wsId}/groups/{groupId}/members", Tag: "Organization", OpID: "setUserGroupMember",
			Summary: "Add or remove a user group member",
			Desc:    "Updates whether a workspace member belongs to the specified user group.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"userId": {Type: "integer"}, "present": {Type: "boolean"}}, "userId", "present"), "Group membership mutation"),
			Resps:   oaStdResp("200", "Group membership updated", "", false),
		},
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/org/sync-sources", Tag: "Organization", OpID: "listOrgSyncSources",
			Summary: "List external directory sync connectors and run history",
			Desc:    "Returns configured SCIM/LDAP/WeCom/DingTalk/custom directory sync connectors and recent sync runs.",
			Resps:   oaStdResp("200", "Sync sources and runs", "", false),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/org/sync-sources", Tag: "Organization", OpID: "createOrgSyncSource",
			Summary: "Create an external directory sync connector",
			Desc:    "Registers a directory sync connector and returns its one-time Bearer push token.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "provider": {Type: "string", Enum: []string{"scim", "ldap", "wecom", "dingtalk", "custom"}}, "autoInviteMissing": {Type: "boolean"}, "pruneMissing": {Type: "boolean"}}, "name", "provider"), "Sync connector payload"),
			Resps:   map[string]oaResp{"201": oaJSONInlineResp("Connector created with token", map[string]any{"type": "object"}), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}/org/sync-sources/{sourceId}", Tag: "Organization", OpID: "updateOrgSyncSource",
			Summary: "Update a directory sync connector or rotate its token",
			Desc:    "Updates connector toggles/name or rotates its Bearer push secret.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "enabled": {Type: "boolean"}, "rotateToken": {Type: "boolean"}}), "Sync connector update"),
			Resps:   oaStdResp("200", "Connector updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/org/sync-sources/{sourceId}", Tag: "Organization", OpID: "deleteOrgSyncSource",
			Summary: "Delete a directory sync connector",
			Desc:    "Deletes the external directory sync connector and revokes its push token.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Connector deleted"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/org/sync-sources/{sourceId}/run", Tag: "Organization", OpID: "runOrgDirectorySync",
			Summary: "Run an idempotent directory snapshot sync",
			Desc:    "Applies or dry-runs a department, group, and membership snapshot sync.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"departments": {Type: "array", ItemsType: "object"}, "groups": {Type: "array", ItemsType: "object"}, "members": {Type: "array", ItemsType: "object"}, "dryRun": {Type: "boolean"}}), "Directory snapshot payload"),
			Resps:   oaStdResp("200", "Sync run summary", "", false),
		},
		{
			Method: "POST", Path: "/api/org/sync/push", Tag: "Organization", OpID: "pushOrgDirectorySync",
			Summary: "Push directory snapshot using connector Bearer token",
			Desc:    "Idempotent webhook/push endpoint authenticated via `Authorization: Bearer jg_sync_...` connector token.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"departments": {Type: "array", ItemsType: "object"}, "groups": {Type: "array", ItemsType: "object"}, "members": {Type: "array", ItemsType: "object"}, "dryRun": {Type: "boolean"}}), "Directory snapshot payload"),
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Push sync completed", map[string]any{"type": "object"}), "401": oaErrResp("Invalid connector token")},
			Public:  true,
		},
	}
}

func oaOpsSCIM() []oaRoute {
	wsQ := oaQueryParam("workspaceId", "integer", "Target workspace ID (defaults to caller's first owner/admin workspace)", false)
	pageParams := []map[string]any{
		oaQueryParam("startIndex", "integer", "1-based pagination offset (default 1)", false),
		oaQueryParam("count", "integer", "Max results per page (default 100, max 200)", false),
	}
	return []oaRoute{
		{
			Method: "GET", Path: "/scim/v2/ServiceProviderConfig", Tag: "SCIM 2.0", OpID: "scimServiceProviderConfig",
			Summary: "Get SCIM 2.0 ServiceProviderConfig",
			Desc:    "Returns RFC 7643 service provider capabilities (PATCH support, filter support, and Bearer PAT authentication scheme).",
			Resps:   map[string]oaResp{"200": {Desc: "SCIM ServiceProviderConfig JSON", Schema: map[string]any{"type": "object"}, ContentType: scimContentType}},
			Public:  true,
		},
		{
			Method: "GET", Path: "/scim/v2/Schemas", Tag: "SCIM 2.0", OpID: "scimListSchemas",
			Summary: "List SCIM 2.0 core schemas",
			Desc:    "Returns an RFC 7643/7644 ListResponse describing the core User and Group schemas with full attribute metadata.",
			Params:  pageParams,
			Resps:   map[string]oaResp{"200": oaSCIMResp("SCIM ListResponse of Schemas", "SCIMListResponse")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/scim/v2/Schemas/{schemaId}", Tag: "SCIM 2.0", OpID: "scimGetSchema",
			Summary: "Get a single SCIM 2.0 schema definition",
			Desc:    "Returns the full attribute descriptor schema for `urn:ietf:params:scim:schemas:core:2.0:User` or `Group`.",
			Resps:   map[string]oaResp{"200": oaSCIMResp("SCIM Schema resource", "SCIMSchema"), "404": oaSCIMErrResp("Schema not found")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/scim/v2/ResourceTypes", Tag: "SCIM 2.0", OpID: "scimListResourceTypes",
			Summary: "List SCIM 2.0 resource types",
			Desc:    "Returns an RFC 7643/7644 ListResponse listing the `User` (`/scim/v2/Users`) and `Group` (`/scim/v2/Groups`) resource types.",
			Params:  pageParams,
			Resps:   map[string]oaResp{"200": oaSCIMResp("SCIM ListResponse of ResourceTypes", "SCIMListResponse")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/scim/v2/ResourceTypes/{typeId}", Tag: "SCIM 2.0", OpID: "scimGetResourceType",
			Summary: "Get a single SCIM 2.0 resource type",
			Desc:    "Returns the `User` or `Group` ResourceType definition (case-insensitive).",
			Resps:   map[string]oaResp{"200": oaSCIMResp("SCIM ResourceType resource", "SCIMResourceType"), "404": oaSCIMErrResp("ResourceType not found")},
			Public:  true,
		},
		{
			Method: "GET", Path: "/scim/v2/Users", Tag: "SCIM 2.0", OpID: "scimListUsers",
			Summary: "List or filter provisioned SCIM users",
			Desc:    "Lists workspace members in RFC 7644 ListResponse format. Requires an admin-scoped PAT and workspace owner/admin role.",
			Params: []map[string]any{
				wsQ,
				oaQueryParam("filter", "string", `SCIM filter expression, e.g. userName eq "alice@example.com"`, false),
				oaQueryParam("startIndex", "integer", "1-based pagination offset (default 1)", false),
				oaQueryParam("count", "integer", "Max results per page (default 100, max 200)", false),
			},
			Resps: map[string]oaResp{
				"200": oaSCIMResp("SCIM ListResponse of Users", "SCIMListResponse"),
				"400": oaSCIMErrResp("Invalid filter or pagination"),
				"401": oaSCIMErrResp("Unauthorized"),
				"403": oaSCIMErrResp("Admin PAT & workspace admin required"),
			},
		},
		{
			Method: "POST", Path: "/scim/v2/Users", Tag: "SCIM 2.0", OpID: "scimCreateUser",
			Summary: "Provision a user via SCIM 2.0",
			Desc:    "Creates a new account (or links an existing account by email) and adds the user to the workspace. Logs `scim.user_provision`.",
			Params:  []map[string]any{wsQ},
			Body: oaSCIMBody(oaObjSchema(map[string]oaProp{
				"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaUser}},
				"userName":    {Type: "string", Format: "email", Description: "Primary email address", Example: "alice@example.com"},
				"displayName": {Type: "string", Example: "Alice Zhang"},
				"active":      {Type: "boolean", Example: true},
				"roles":       {Type: "array", ItemsType: "object", Description: "Workspace roles (member or admin)"},
			}, "userName"), "SCIM 2.0 User resource"),
			Resps: map[string]oaResp{
				"201": oaSCIMResp("User provisioned", "SCIMUser"),
				"400": oaSCIMErrResp("Invalid SCIM User"),
				"403": oaSCIMErrResp("Admin PAT required"),
				"409": oaSCIMErrResp("User already exists in workspace"),
			},
		},
		{
			Method: "GET", Path: "/scim/v2/Users/{uid}", Tag: "SCIM 2.0", OpID: "scimGetUser",
			Summary: "Get a single SCIM 2.0 user",
			Desc:    "Returns the SCIM 2.0 User resource for a workspace member.",
			Params:  []map[string]any{wsQ},
			Resps:   map[string]oaResp{"200": oaSCIMResp("SCIM User resource", "SCIMUser"), "404": oaSCIMErrResp("User not in workspace")},
		},
		{
			Method: "PUT", Path: "/scim/v2/Users/{uid}", Tag: "SCIM 2.0", OpID: "scimPutUser",
			Summary: "Replace a SCIM 2.0 user resource",
			Desc:    "Performs RFC 7644 full replacement of displayName, workspace role, and active status (deprovisioning on active=false or reactivating on active=true).",
			Params:  []map[string]any{wsQ},
			Body: oaSCIMBody(oaObjSchema(map[string]oaProp{
				"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaUser}},
				"userName":    {Type: "string", Format: "email", Example: "alice@example.com"},
				"displayName": {Type: "string", Example: "Alice Zhang"},
				"active":      {Type: "boolean", Example: true},
				"roles":       {Type: "array", ItemsType: "object"},
			}, "userName"), "SCIM 2.0 User replacement payload"),
			Resps: map[string]oaResp{
				"200": oaSCIMResp("Replaced SCIM User resource", "SCIMUser"),
				"400": oaSCIMErrResp("Invalid User replacement payload"),
				"403": oaSCIMErrResp("Admin PAT required or workspace owner protected"),
				"404": oaSCIMErrResp("User not found"),
			},
		},
		{
			Method: "PATCH", Path: "/scim/v2/Users/{uid}", Tag: "SCIM 2.0", OpID: "scimPatchUser",
			Summary: "Update role or deactivate/deprovision a SCIM user",
			Desc:    "Applies RFC 7644 PatchOp operations. Setting `active: false` removes the user from the workspace (workspace owners are protected).",
			Params:  []map[string]any{wsQ},
			Body: oaSCIMBody(oaObjSchema(map[string]oaProp{
				"schemas":    {Type: "array", ItemsType: "string", Example: []string{scimSchemaPatchOp}},
				"Operations": {Type: "array", ItemsType: "object", Description: "SCIM PatchOp operations (replace active / roles)"},
			}, "Operations"), "SCIM PatchOp payload"),
			Resps: map[string]oaResp{
				"200": oaSCIMResp("Updated or deactivated SCIM User", "SCIMUser"),
				"403": oaSCIMErrResp("Cannot modify/deprovision workspace owner"),
				"404": oaSCIMErrResp("User not found"),
			},
		},
		{
			Method: "DELETE", Path: "/scim/v2/Users/{uid}", Tag: "SCIM 2.0", OpID: "scimDeleteUser",
			Summary: "Deprovision a user from the workspace",
			Desc:    "Removes the user from the workspace and cleans up department/group/wiki grants. Logs `scim.user_deprovision`.",
			Params:  []map[string]any{wsQ},
			Resps:   map[string]oaResp{"204": oaPlainResp("User deprovisioned"), "403": oaSCIMErrResp("Cannot remove workspace owner"), "404": oaSCIMErrResp("User not found")},
		},
		{
			Method: "GET", Path: "/scim/v2/Groups", Tag: "SCIM 2.0", OpID: "scimListGroups",
			Summary: "List SCIM 2.0 groups",
			Desc:    "Lists workspace user groups in RFC 7644 ListResponse format with optional `displayName` filter.",
			Params: []map[string]any{
				wsQ,
				oaQueryParam("filter", "string", `SCIM filter expression, e.g. displayName eq "Engineering"`, false),
				oaQueryParam("startIndex", "integer", "1-based pagination offset", false),
				oaQueryParam("count", "integer", "Page size (max 200)", false),
			},
			Resps: map[string]oaResp{"200": oaSCIMResp("SCIM ListResponse of Groups", "SCIMListResponse"), "403": oaSCIMErrResp("Admin PAT required")},
		},
		{
			Method: "POST", Path: "/scim/v2/Groups", Tag: "SCIM 2.0", OpID: "scimCreateGroup",
			Summary: "Create a SCIM 2.0 group",
			Desc:    "Creates a workspace user group and binds initial workspace members.",
			Params:  []map[string]any{wsQ},
			Body: oaSCIMBody(oaObjSchema(map[string]oaProp{
				"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaGroup}},
				"displayName": {Type: "string", Example: "Engineering"},
				"members":     {Type: "array", ItemsType: "object", Description: "Initial member references ({value: userId})"},
			}, "displayName"), "SCIM Group payload"),
			Resps: map[string]oaResp{"201": oaSCIMResp("Group created", "SCIMGroup"), "400": oaSCIMErrResp("Invalid group or member"), "403": oaSCIMErrResp("Admin PAT required")},
		},
		{
			Method: "GET", Path: "/scim/v2/Groups/{gid}", Tag: "SCIM 2.0", OpID: "scimGetGroup",
			Summary: "Get a single SCIM 2.0 group",
			Desc:    "Returns a single workspace user group with member references.",
			Params:  []map[string]any{wsQ},
			Resps:   map[string]oaResp{"200": oaSCIMResp("SCIM Group resource", "SCIMGroup"), "404": oaSCIMErrResp("Group not found")},
		},
		{
			Method: "PUT", Path: "/scim/v2/Groups/{gid}", Tag: "SCIM 2.0", OpID: "scimPutGroup",
			Summary: "Replace a SCIM 2.0 group and its exact member set",
			Desc:    "Performs RFC 7644 full replacement of group `displayName` and reconciles exact group membership (adding missing members and removing omitted ones).",
			Params:  []map[string]any{wsQ},
			Body: oaSCIMBody(oaObjSchema(map[string]oaProp{
				"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaGroup}},
				"displayName": {Type: "string", Example: "Platform Engineering"},
				"members":     {Type: "array", ItemsType: "object", Description: "Exact member reference set ({value: userId})"},
			}, "displayName"), "SCIM Group replacement payload"),
			Resps: map[string]oaResp{
				"200": oaSCIMResp("Replaced SCIM Group resource", "SCIMGroup"),
				"400": oaSCIMErrResp("Invalid displayName or member"),
				"403": oaSCIMErrResp("Admin PAT required"),
				"404": oaSCIMErrResp("Group not found"),
			},
		},
		{
			Method: "PATCH", Path: "/scim/v2/Groups/{gid}", Tag: "SCIM 2.0", OpID: "scimPatchGroup",
			Summary: "Rename a SCIM group or modify its members",
			Desc:    "Applies RFC 7644 PatchOp operations to rename `displayName` or add/remove/replace `members`.",
			Params:  []map[string]any{wsQ},
			Body: oaSCIMBody(oaObjSchema(map[string]oaProp{
				"schemas":    {Type: "array", ItemsType: "string", Example: []string{scimSchemaPatchOp}},
				"Operations": {Type: "array", ItemsType: "object", Description: "PatchOp operations for displayName and members"},
			}, "Operations"), "SCIM Group PatchOp payload"),
			Resps: map[string]oaResp{"200": oaSCIMResp("Group updated", "SCIMGroup"), "400": oaSCIMErrResp("Invalid patch operation"), "404": oaSCIMErrResp("Group not found")},
		},
		{
			Method: "DELETE", Path: "/scim/v2/Groups/{gid}", Tag: "SCIM 2.0", OpID: "scimDeleteGroup",
			Summary: "Delete a SCIM 2.0 group",
			Desc:    "Deletes the workspace user group and revokes its subject-based document/wiki grants.",
			Params:  []map[string]any{wsQ},
			Resps:   map[string]oaResp{"204": oaPlainResp("Group deleted"), "404": oaSCIMErrResp("Group not found")},
		},
	}
}

func oaOpsSecurityWebhooksNotif() []oaRoute {
	auditPageSchema := oaObjSchema(map[string]oaProp{
		"items":   {Type: "array", ItemsRef: "AuditLogEntry"},
		"total":   {Type: "integer", Example: 42},
		"actions": {Type: "array", ItemsType: "string"},
	}, "items", "total")

	return []oaRoute{
		// Security, Audit, SSO & Retention
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/audit-logs", Tag: "Security & Audit", OpID: "listWorkspaceAuditLogs",
			Summary: "Query workspace security audit logs",
			Desc:    "Filters and paginates security audit events by action, resourceType, actorId, time range, or keyword.",
			Params: []map[string]any{
				oaQueryParam("action", "string", "Filter by audit action (e.g. scim.user_provision, auth.login)", false),
				oaQueryParam("resourceType", "string", "Filter by resource type", false),
				oaQueryParam("q", "string", "Full-text keyword filter", false),
				oaQueryParam("from", "string", "Start timestamp (RFC3339 or YYYY-MM-DD)", false),
				oaQueryParam("to", "string", "End timestamp (RFC3339 or YYYY-MM-DD)", false),
				oaQueryParam("limit", "integer", "Page size", false),
				oaQueryParam("offset", "integer", "Pagination offset", false),
			},
			Resps: map[string]oaResp{"200": oaJSONInlineResp("Paginated audit log entries", auditPageSchema), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/audit-logs/export", Tag: "Security & Audit", OpID: "exportWorkspaceAuditLogs",
			Summary: "Export workspace audit logs as CSV",
			Desc:    "Streams formula-injection-safe UTF-8 BOM CSV export of matching security audit logs.",
			Params: []map[string]any{
				oaQueryParam("action", "string", "Filter by action", false),
				oaQueryParam("from", "string", "Start timestamp (RFC3339 or YYYY-MM-DD)", false),
				oaQueryParam("to", "string", "End timestamp (RFC3339 or YYYY-MM-DD)", false),
			},
			Resps: map[string]oaResp{"200": oaTextResp("CSV attachment download", "text/csv"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/security-policy", Tag: "Security & Audit", OpID: "getWorkspaceSecurityPolicy",
			Summary: "Get workspace watermark, DLP, and retention security policy",
			Desc:    "Returns watermark configuration, Data Loss Prevention (DLP) rules, and retention settings for the workspace.",
			Resps:   oaStdResp("200", "Workspace security policy", "SecurityPolicy", false),
		},
		{
			Method: "PUT", Path: "/api/workspaces/{wsId}/security-policy", Tag: "Security & Audit", OpID: "putWorkspaceSecurityPolicy",
			Summary: "Update workspace watermark, DLP, and retention policy",
			Desc:    "Configures global document/sheet/base/slides watermark overlay, DLP sensitive rules, and retention purge days.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"watermarkEnabled":    {Type: "boolean", Example: true},
				"watermarkText":       {Type: "string", Example: "CONFIDENTIAL"},
				"watermarkShowUser":   {Type: "boolean", Example: true},
				"watermarkShowEmail":  {Type: "boolean", Example: true},
				"watermarkShowDate":   {Type: "boolean", Example: true},
				"watermarkOpacity":    {Type: "number", Example: 0.12},
				"dlpEnabled":          {Type: "boolean", Example: true},
				"dlpKeywords":         {Type: "array", ItemsType: "string"},
				"dlpAction":           {Type: "string", Enum: []string{"warn", "block"}, Example: "block"},
				"dlpBlockPublicShare": {Type: "boolean", Example: true},
				"retentionDays":       {Type: "integer", Example: 90},
			}), "Security & DLP policy update"),
			Resps: map[string]oaResp{"200": oaJSONResp("Updated security policy", "SecurityPolicy"), "400": oaErrResp("Invalid policy values"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/dlp/check", Tag: "Security & Audit", OpID: "checkWorkspaceDLP",
			Summary: "Test text against workspace DLP rules",
			Desc:    "Evaluates sample text against saved or draft DLP keywords/regexes and returns matched snippets and enforcement action.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"text":     {Type: "string", Example: "Customer SSN 123-45-6789"},
				"keywords": {Type: "array", ItemsType: "string", Description: "Optional draft DLP rules"},
				"action":   {Type: "string", Enum: []string{"warn", "block"}},
			}, "text"), "DLP evaluation input"),
			Resps: map[string]oaResp{"200": oaJSONResp("DLP evaluation result", "DLPCheckResult"), "400": oaErrResp("Invalid rules"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/retention/run", Tag: "Security & Audit", OpID: "runWorkspaceRetentionPurge",
			Summary: "Execute workspace data-retention purge",
			Desc:    "Purges audit logs and trashed documents older than the workspace's configured `retentionDays` (supports dry-run preview).",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"dryRun": {Type: "boolean", Description: "Preview purge counts without deleting", Example: false}}), "Retention run options"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Retention purge summary", "RetentionPurgeResult"), "400": oaErrResp("Retention policy disabled"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/sso/providers", Tag: "Security & Audit", OpID: "listWorkspaceSSOProviders",
			Summary: "List workspace SSO identity providers",
			Desc:    "Lists configured OIDC/OAuth2 enterprise SSO connectors (client secrets are never returned).",
			Resps:   oaStdResp("200", "SSO provider list", "", false),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/sso/providers", Tag: "Security & Audit", OpID: "createWorkspaceSSOProvider",
			Summary: "Create a workspace SSO identity provider",
			Desc:    "Registers an OIDC/OAuth2 IdP (Okta, Azure AD, Keycloak, Feishu, etc.) with encrypted client secret.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name":         {Type: "string", Example: "Okta Corp SSO"},
				"slug":         {Type: "string", Example: "okta-corp"},
				"issuerUrl":    {Type: "string", Example: "https://corp.okta.com/oauth2/default"},
				"clientId":     {Type: "string"},
				"clientSecret": {Type: "string"},
			}, "name", "slug", "issuerUrl", "clientId"), "SSO provider configuration"),
			Resps: map[string]oaResp{"201": oaJSONInlineResp("SSO provider created", map[string]any{"type": "object"}), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}/sso/providers/{pid}", Tag: "Security & Audit", OpID: "updateWorkspaceSSOProvider",
			Summary: "Update a workspace SSO identity provider",
			Desc:    "Updates endpoints, scopes, enabled toggle, or rotates encrypted client secret for an SSO provider.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "enabled": {Type: "boolean"}, "clientSecret": {Type: "string"}}), "SSO provider patch"),
			Resps:   oaStdResp("200", "SSO provider updated", "", false),
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/sso/providers/{pid}", Tag: "Security & Audit", OpID: "deleteWorkspaceSSOProvider",
			Summary: "Delete a workspace SSO identity provider",
			Desc:    "Removes an SSO identity provider configuration from the workspace.",
			Resps:   map[string]oaResp{"204": oaPlainResp("SSO provider deleted"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/sso/discover", Tag: "Security & Audit", OpID: "discoverSSOProvider",
			Summary: "Discover OIDC endpoints from well-known configuration URL",
			Desc:    "Fetches `.well-known/openid-configuration` safely with SSRF checks to prefill authorization, token, and userinfo URLs.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"issuerUrl": {Type: "string", Example: "https://corp.okta.com/oauth2/default"}}, "issuerUrl"), "OIDC discovery request"),
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Discovered OIDC endpoints", map[string]any{"type": "object"}), "400": oaErrResp("Discovery failed")},
		},

		// Webhooks
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/webhooks", Tag: "Webhooks", OpID: "listWorkspaceWebhooks",
			Summary: "List workspace event webhooks",
			Desc:    "Lists all configured outbound HMAC-SHA256 webhooks for the workspace.",
			Resps:   oaStdResp("200", "Webhook list", "Webhook", true),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/webhooks", Tag: "Webhooks", OpID: "createWorkspaceWebhook",
			Summary: "Create a workspace event webhook",
			Desc:    "Creates an outbound webhook subscribing to collaboration events. Returns signing secret once.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name":    {Type: "string", Example: "Enterprise Event Bus"},
				"url":     {Type: "string", Format: "uri", Example: "https://hooks.example.com/jiange"},
				"events":  {Type: "array", ItemsType: "string", Example: []string{"doc.created", "share.updated"}},
				"enabled": {Type: "boolean", Example: true},
			}, "name", "url", "events"), "Webhook creation payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Webhook created with signing secret", "Webhook"), "400": oaErrResp("Invalid URL or events"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}/webhooks/{wid}", Tag: "Webhooks", OpID: "updateWorkspaceWebhook",
			Summary: "Update a workspace webhook",
			Desc:    "Updates webhook name, target URL, subscribed events, enabled state, or rotates signing secret.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "url": {Type: "string"}, "events": {Type: "array", ItemsType: "string"}, "enabled": {Type: "boolean"}}), "Webhook update payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Webhook updated", "Webhook"), "404": oaErrResp("Webhook not found")},
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/webhooks/{wid}", Tag: "Webhooks", OpID: "deleteWorkspaceWebhook",
			Summary: "Delete a workspace webhook",
			Desc:    "Deletes the webhook and stops event deliveries.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Webhook deleted"), "404": oaErrResp("Webhook not found")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/webhooks/{wid}/test", Tag: "Webhooks", OpID: "testWorkspaceWebhook",
			Summary: "Send a signed test webhook event",
			Desc:    "Dispatches a `webhook.test` event signed with `X-Jiange-Signature` and returns HTTP status & latency.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Test delivery result", map[string]any{"type": "object"}), "404": oaErrResp("Webhook not found")},
		},
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/webhooks/{wid}/deliveries", Tag: "Webhooks", OpID: "listWebhookDeliveries",
			Summary: "List recent webhook delivery logs",
			Desc:    "Returns recent delivery attempts, HTTP status codes, retries, and response snippets.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Delivery history", map[string]any{"type": "array", "items": map[string]any{"type": "object"}}), "404": oaErrResp("Webhook not found")},
		},

		// External Notification Channels
		{
			Method: "GET", Path: "/api/workspaces/{wsId}/notification-channels", Tag: "Notification Channels", OpID: "listNotificationChannels",
			Summary: "List external notification channels",
			Desc:    "Lists configured SMTP email and IM bot (Feishu, DingTalk, WeCom, Slack) notification channels with masked config hints.",
			Resps:   oaStdResp("200", "Notification channel list", "NotificationChannel", true),
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/notification-channels", Tag: "Notification Channels", OpID: "createNotificationChannel",
			Summary: "Create an external notification channel",
			Desc:    "Encrypts credentials with AES-256-GCM and creates an SMTP or IM bot notification channel.",
			Body: oaJSONBody(oaObjSchema(map[string]oaProp{
				"name":    {Type: "string", Example: "Engineering Feishu Alerts"},
				"kind":    {Type: "string", Enum: []string{"smtp", "feishu_bot", "dingtalk_bot", "wecom_bot", "slack_bot"}, Example: "feishu_bot"},
				"config":  {Type: "object", Description: "Channel-specific encrypted connection config"},
				"events":  {Type: "array", ItemsType: "string", Example: []string{"mention", "comment_reply", "automation"}},
				"enabled": {Type: "boolean", Example: true},
			}, "name", "kind", "config", "events"), "Notification channel payload"),
			Resps: map[string]oaResp{"201": oaJSONResp("Channel created", "NotificationChannel"), "400": oaErrResp("Invalid channel config"), "403": oaErrResp("Workspace admin required")},
		},
		{
			Method: "PATCH", Path: "/api/workspaces/{wsId}/notification-channels/{cid}", Tag: "Notification Channels", OpID: "updateNotificationChannel",
			Summary: "Update an external notification channel",
			Desc:    "Updates channel name, events, enabled toggle, or encrypted connection credentials.",
			Body:    oaJSONBody(oaObjSchema(map[string]oaProp{"name": {Type: "string"}, "events": {Type: "array", ItemsType: "string"}, "enabled": {Type: "boolean"}, "config": {Type: "object"}}), "Channel update payload"),
			Resps:   map[string]oaResp{"200": oaJSONResp("Channel updated", "NotificationChannel"), "404": oaErrResp("Channel not found")},
		},
		{
			Method: "DELETE", Path: "/api/workspaces/{wsId}/notification-channels/{cid}", Tag: "Notification Channels", OpID: "deleteNotificationChannel",
			Summary: "Delete an external notification channel",
			Desc:    "Removes the notification channel and stops external pushes.",
			Resps:   map[string]oaResp{"204": oaPlainResp("Channel deleted"), "404": oaErrResp("Channel not found")},
		},
		{
			Method: "POST", Path: "/api/workspaces/{wsId}/notification-channels/{cid}/test", Tag: "Notification Channels", OpID: "testNotificationChannel",
			Summary: "Send a test notification to a channel",
			Desc:    "Dispatches a live connectivity test message to the configured SMTP server or IM bot.",
			Resps:   map[string]oaResp{"200": oaJSONInlineResp("Test dispatch result with latency", map[string]any{"type": "object"}), "404": oaErrResp("Channel not found")},
		},
	}
}

func oaOpsRealtime() []oaRoute {
	return []oaRoute{
		{
			Method: "GET", Path: "/api/sync", Tag: "Realtime Sync", OpID: "syncDocumentsWS",
			Summary: "WebSocket realtime document CRDT sync",
			Desc:    "Upgrades an authenticated browser session to a WebSocket channel for collaborative document editing and presence.",
			Resps:   map[string]oaResp{"101": oaPlainResp("Switching Protocols (WebSocket)"), "401": oaErrResp("Session cookie required")},
		},
		{
			Method: "GET", Path: "/api/bases/{id}/sync", Tag: "Realtime Sync", OpID: "syncBaseWS",
			Summary: "WebSocket realtime Base updates",
			Desc:    "Upgrades to a WebSocket channel streaming live Base record, field, and view mutations.",
			Resps:   map[string]oaResp{"101": oaPlainResp("Switching Protocols (WebSocket)"), "403": oaErrResp("View permission required")},
		},
		{
			Method: "GET", Path: "/api/sheets/{id}/ws", Tag: "Realtime Sync", OpID: "syncSheetWS",
			Summary: "WebSocket realtime spreadsheet collaboration",
			Desc:    "Upgrades to a WebSocket channel streaming live cell edits and collaborator cursors for a spreadsheet.",
			Resps:   map[string]oaResp{"101": oaPlainResp("Switching Protocols (WebSocket)"), "403": oaErrResp("View permission required")},
		},
		{
			Method: "GET", Path: "/api/slides/{id}/ws", Tag: "Realtime Sync", OpID: "syncSlidesWS",
			Summary: "WebSocket realtime presentation collaboration",
			Desc:    "Upgrades to a WebSocket channel streaming live slide canvas edits and presence.",
			Resps:   map[string]oaResp{"101": oaPlainResp("Switching Protocols (WebSocket)"), "403": oaErrResp("View permission required")},
		},
	}
}

func buildOpenAPISpec() map[string]any {
	paths := map[string]any{}
	oaRegisterRoutes(paths, oaOpsHealthAndDeveloper())
	oaRegisterRoutes(paths, oaOpsAuthAndPAT())
	oaRegisterRoutes(paths, oaOpsDocs())
	oaRegisterRoutes(paths, oaOpsSheets())
	oaRegisterRoutes(paths, oaOpsBases())
	oaRegisterRoutes(paths, oaOpsSlides())
	oaRegisterRoutes(paths, oaOpsDrive())
	oaRegisterRoutes(paths, oaOpsWikiAndSurveys())
	oaRegisterRoutes(paths, oaOpsAI())
	oaRegisterRoutes(paths, oaOpsOrgAndWorkspaces())
	oaRegisterRoutes(paths, oaOpsSCIM())
	oaRegisterRoutes(paths, oaOpsSecurityWebhooksNotif())
	oaRegisterRoutes(paths, oaOpsRealtime())

	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":   "Jiange Open API",
			"version": "0.2.0",
			"description": "Jiange collaborative office suite Open API covering Health & Observability, Authentication & MFA/SSO, Personal Access Tokens (PAT), " +
				"Docs, Sheets, Bases, Slides, Drive & Cross-Space Move, Wiki Spaces, Surveys & Public Links, AI Suite (Workspace RAG, Sheet Assist, Base Autofill), " +
				"Organization & Workspace Lifecycle, RFC 7643/7644 SCIM 2.0 Provisioning, Security Audit/DLP/Retention Policies, Webhooks, Notification Channels, and Realtime Sync.",
		},
		"servers": []map[string]any{
			{
				"url":         "/",
				"description": "Current Jiange server origin",
			},
		},
		"security": []map[string]any{
			{"bearerPAT": []string{}},
			{"sessionCookie": []string{}},
		},
		"tags": []map[string]any{
			{"name": "Health & Observability", "description": "Liveness, readiness probes, and Prometheus metrics"},
			{"name": "Auth & MFA", "description": "Account authentication, TOTP two-factor authentication, and enterprise SSO"},
			{"name": "Personal Access Tokens", "description": "Bearer Personal Access Token (jg_pat_...) lifecycle and scopes"},
			{"name": "Docs", "description": "Collaborative documents, sharing ACLs, public links, versions, comments, suggestions, and full-text search"},
			{"name": "Sheets", "description": "Multi-worksheet spreadsheets, batch cell writes, defined names, comments, and versions"},
			{"name": "Bases", "description": "Multi-dimensional tables, views, dashboards, structured queries, records, and automation rules"},
			{"name": "Slides", "description": "Presentation decks, slide canvas pages, comments, and version snapshots"},
			{"name": "Drive", "description": "Workspace folders, files, shortcuts, hierarchy navigation, trash/restore, and cross-space move"},
			{"name": "Wiki", "description": "Independent knowledge spaces, tree hierarchy, and subject grants"},
			{"name": "Surveys & Public", "description": "Surveys, anonymous public forms, and password-protected public links"},
			{"name": "AI Suite", "description": "Encrypted AI provider config, Document AI, Workspace RAG Q&A, Sheet Assist, and Base Autofill"},
			{"name": "Organization", "description": "Workspace lifecycle, members, invitations, hierarchical departments, user groups, and directory sync"},
			{"name": "SCIM 2.0", "description": "RFC 7643 / 7644 SCIM 2.0 discovery, user, and group provisioning for Okta, Azure AD, and Feishu"},
			{"name": "Security & Audit", "description": "Security audit logs, CSV export, watermark/DLP/retention policies, and SSO IdP management"},
			{"name": "Webhooks", "description": "HMAC-SHA256 signed workspace event webhooks and delivery history"},
			{"name": "Notification Channels", "description": "External SMTP email and Feishu/DingTalk/WeCom/Slack bot alert channels"},
			{"name": "Realtime Sync", "description": "WebSocket collaborative editing channels for Docs, Bases, Sheets, and Slides"},
			{"name": "Developer", "description": "OpenAPI 3.1.0 machine-readable schema discovery"},
		},
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"bearerPAT": map[string]any{
					"type":         "http",
					"scheme":       "bearer",
					"bearerFormat": "jg_pat_...",
					"description":  "Jiange Personal Access Token (`jg_pat_...`) supplied in `Authorization: Bearer <token>`. Scopes: `read`, `write`, `admin` (`admin` required for SCIM 2.0).",
				},
				"sessionCookie": map[string]any{
					"type":        "apiKey",
					"in":          "cookie",
					"name":        CookieName,
					"description": "HttpOnly SameSite=Lax browser session cookie issued by `/api/auth/login` or SSO callback.",
				},
			},
			"schemas": oaSchemas(),
		},
		"paths": paths,
	}
}

func cachedOpenAPISpecJSON() []byte {
	openAPISpecOnce.Do(func() {
		b, err := json.MarshalIndent(buildOpenAPISpec(), "", "  ")
		if err != nil {
			b = []byte(`{"openapi":"3.1.0","info":{"title":"Jiange Open API","version":"0.2.0"},"paths":{}}`)
		}
		openAPISpecBytes = b
	})
	return openAPISpecBytes
}

// getOpenAPISpec serves the OpenAPI 3.1.0 specification at GET /api/openapi.json.
func (s *Server) getOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(cachedOpenAPISpecJSON())
}
