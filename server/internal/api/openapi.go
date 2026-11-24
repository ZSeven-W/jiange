package api

import (
	"encoding/json"
	"net/http"
	"sync"
)

var (
	openAPISpecOnce  sync.Once
	openAPISpecBytes []byte
)

type oaProp struct {
	Type        string
	Description string
	Example     any
	Enum        []string
	ItemsType   string
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
		field := map[string]any{"type": p.Type}
		if p.Description != "" {
			field["description"] = p.Description
		}
		if p.Example != nil {
			field["example"] = p.Example
		}
		if len(p.Enum) > 0 {
			field["enum"] = p.Enum
		}
		if p.Type == "array" && p.ItemsType != "" {
			field["items"] = map[string]any{"type": p.ItemsType}
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

func oaResponses(codes map[string]string) map[string]any {
	out := make(map[string]any, len(codes))
	for code, desc := range codes {
		out[code] = map[string]any{"description": desc}
	}
	return out
}

func oaOp(tag, opID, summary, desc string, params []map[string]any, body map[string]any, responses map[string]string, public bool) map[string]any {
	op := map[string]any{
		"tags":        []string{tag},
		"operationId": opID,
		"summary":     summary,
		"description": desc,
		"responses":   oaResponses(responses),
	}
	if len(params) > 0 {
		op["parameters"] = params
	}
	if body != nil {
		op["requestBody"] = body
	}
	if public {
		op["security"] = []any{}
	}
	return op
}

func buildOpenAPISpec() map[string]any {
	wsParam := oaPathParam("wsId", "Workspace ID")
	docParam := oaPathParam("id", "Document or resource ID")
	scimWSQuery := oaQueryParam("workspaceId", "integer", "Target workspace ID (defaults to caller's first owner/admin workspace)", false)

	paths := map[string]any{
		// --- Auth, MFA & SSO ---
		"/api/auth/register": map[string]any{
			"post": oaOp("Auth & MFA", "authRegister", "Register a new user account",
				"Creates a user account, provisions a personal workspace, and issues an HttpOnly session cookie.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"email":    {Type: "string", Description: "User email address", Example: "alice@example.com"},
					"name":     {Type: "string", Description: "Display name (1-64 chars)", Example: "Alice"},
					"password": {Type: "string", Description: "Password (8-256 chars)"},
				}, "email", "name", "password"), "Registration credentials"),
				map[string]string{"201": "Account created", "400": "Invalid input", "409": "Email already registered"},
				true,
			),
		},
		"/api/auth/login": map[string]any{
			"post": oaOp("Auth & MFA", "authLogin", "Sign in with email and password",
				"Verifies credentials and either starts a session or returns an MFA challenge when TOTP MFA is enabled.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"email":    {Type: "string", Example: "alice@example.com"},
					"password": {Type: "string"},
				}, "email", "password"), "Login credentials"),
				map[string]string{"200": "Authenticated or MFA challenge issued", "401": "Invalid credentials"},
				true,
			),
		},
		"/api/auth/logout": map[string]any{
			"post": oaOp("Auth & MFA", "authLogout", "Sign out current session",
				"Revokes the active browser session cookie and appends an audit entry.",
				nil, nil,
				map[string]string{"204": "Signed out"},
				false,
			),
		},
		"/api/me": map[string]any{
			"get": oaOp("Auth & MFA", "getMe", "Get current authenticated user and workspaces",
				"Returns the caller's profile and all workspaces they belong to. Accepts Bearer PAT or session cookie.",
				nil, nil,
				map[string]string{"200": "Current user and workspaces", "401": "Unauthorized"},
				false,
			),
		},
		"/api/auth/mfa/verify": map[string]any{
			"post": oaOp("Auth & MFA", "verifyMFALogin", "Complete MFA login challenge",
				"Validates a 6-digit TOTP code or one-time backup recovery code to complete sign-in.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"challengeToken": {Type: "string", Description: "Opaque MFA challenge token from login"},
					"code":           {Type: "string", Description: "6-digit TOTP code or recovery code", Example: "123456"},
				}, "challengeToken", "code"), "MFA verification payload"),
				map[string]string{"200": "MFA verified and session started", "401": "Invalid or expired challenge/code"},
				true,
			),
		},
		"/api/me/mfa": map[string]any{
			"get": oaOp("Auth & MFA", "getMyMFA", "Get personal MFA enrollment status",
				"Returns whether TOTP MFA is enabled and the count of remaining backup recovery codes.",
				nil, nil,
				map[string]string{"200": "MFA status", "401": "Unauthorized"},
				false,
			),
		},
		"/api/me/mfa/setup": map[string]any{
			"post": oaOp("Auth & MFA", "setupMyMFA", "Initialize TOTP MFA secret",
				"Generates a new TOTP secret and otpauth URI for authenticator app enrollment.",
				nil, nil,
				map[string]string{"200": "TOTP setup details", "401": "Unauthorized"},
				false,
			),
		},
		"/api/me/mfa/enable": map[string]any{
			"post": oaOp("Auth & MFA", "enableMyMFA", "Verify and enable TOTP MFA",
				"Confirms the pending TOTP secret with a valid code and returns one-time backup recovery codes.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"code": {Type: "string", Description: "6-digit TOTP verification code", Example: "123456"},
				}, "code"), "TOTP confirmation code"),
				map[string]string{"200": "MFA enabled with recovery codes", "400": "Invalid verification code"},
				false,
			),
		},
		"/api/me/mfa/disable": map[string]any{
			"post": oaOp("Auth & MFA", "disableMyMFA", "Disable TOTP MFA",
				"Disables TOTP MFA after verifying password or current TOTP/recovery code.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"code": {Type: "string", Description: "Current TOTP or backup code"},
				}, "code"), "MFA disable confirmation"),
				map[string]string{"204": "MFA disabled", "400": "Invalid code"},
				false,
			),
		},
		"/api/auth/sso/providers": map[string]any{
			"get": oaOp("Auth & MFA", "listPublicSSOProviders", "List enabled enterprise SSO providers",
				"Returns public metadata for enabled OIDC/OAuth2/SAML identity providers for the login page.",
				nil, nil,
				map[string]string{"200": "Enabled SSO provider list"},
				true,
			),
		},
		"/api/auth/sso/{slug}/start": map[string]any{
			"get": oaOp("Auth & MFA", "startSSO", "Initiate enterprise SSO authentication",
				"Redirects the browser to the configured OIDC/OAuth2 authorization endpoint with PKCE & state.",
				[]map[string]any{oaPathParam("slug", "SSO provider slug")},
				nil,
				map[string]string{"302": "Redirect to IdP", "404": "SSO provider not found"},
				true,
			),
		},

		// --- Personal Access Tokens (PAT) ---
		"/api/me/tokens": map[string]any{
			"get": oaOp("Personal Access Tokens", "listMyPATs", "List personal access tokens",
				"Lists all Personal Access Tokens belonging to the authenticated user (never returns raw token secrets).",
				nil, nil,
				map[string]string{"200": "List of PAT metadata", "401": "Unauthorized"},
				false,
			),
			"post": oaOp("Personal Access Tokens", "createMyPAT", "Create a Personal Access Token",
				"Creates a new Bearer PAT (`jg_pat_...`) with specified scopes (`read`, `write`, `admin`) and optional expiration. The raw token is returned once.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":          {Type: "string", Description: "Token display name (1-80 chars)", Example: "CI Automation"},
					"scopes":        {Type: "array", ItemsType: "string", Description: "Allowed scopes: read, write, admin", Example: []string{"read", "write"}},
					"expiresInDays": {Type: "integer", Description: "Optional lifetime in days (1-365; omit for no expiry)", Example: 90},
				}, "name"), "PAT creation request"),
				map[string]string{"201": "PAT created with one-time rawToken", "400": "Invalid name, scopes, or expiry", "409": "Maximum active PAT limit reached"},
				false,
			),
		},
		"/api/me/tokens/{tid}": map[string]any{
			"delete": oaOp("Personal Access Tokens", "revokeMyPAT", "Revoke a Personal Access Token",
				"Immediately revokes the specified PAT so subsequent Bearer requests are rejected with 401.",
				[]map[string]any{oaPathParam("tid", "Personal Access Token ID")},
				nil,
				map[string]string{"204": "PAT revoked", "404": "PAT not found"},
				false,
			),
		},

		// --- Docs ---
		"/api/docs": map[string]any{
			"get": oaOp("Docs", "listDocs", "List workspace documents and nodes",
				"Lists documents, sheets, bases, slides, and folders inside a workspace accessible to the caller.",
				[]map[string]any{oaQueryParam("workspaceId", "integer", "Workspace ID", true)},
				nil,
				map[string]string{"200": "Document list", "401": "Unauthorized"},
				false,
			),
			"post": oaOp("Docs", "createDoc", "Create a new document, sheet, base, or slide deck",
				"Creates a new collaborative node inside the target workspace.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"workspaceId": {Type: "integer", Description: "Target workspace ID", Example: 1},
					"title":       {Type: "string", Description: "Document title", Example: "Q4 Architecture RFC"},
					"kind":        {Type: "string", Description: "Node kind", Enum: []string{"doc", "sheet", "base", "slides", "mindmap", "whiteboard", "survey"}, Example: "doc"},
					"parentId":    {Type: "integer", Description: "Optional parent folder ID"},
				}, "workspaceId", "title"), "Document creation payload"),
				map[string]string{"201": "Document created", "400": "Invalid parameters", "403": "Forbidden"},
				false,
			),
		},
		"/api/docs/{id}": map[string]any{
			"get": oaOp("Docs", "getDoc", "Get document metadata and content",
				"Returns full document metadata, content snapshot, and caller permission role.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Document details", "403": "Forbidden", "404": "Not found"},
				false,
			),
			"patch": oaOp("Docs", "patchDoc", "Update document title or metadata",
				"Updates document title, icon, or editable attributes.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"title": {Type: "string", Description: "Updated document title", Example: "Updated Title"},
				}), "Document patch payload"),
				map[string]string{"200": "Document updated", "403": "Forbidden", "404": "Not found"},
				false,
			),
			"delete": oaOp("Docs", "trashDoc", "Move document to trash",
				"Soft-deletes the document into workspace trash.",
				[]map[string]any{docParam}, nil,
				map[string]string{"204": "Moved to trash", "403": "Forbidden", "404": "Not found"},
				false,
			),
		},
		"/api/docs/{id}/shares": map[string]any{
			"get": oaOp("Docs", "getDocShares", "Get document sharing ACLs and link settings",
				"Returns collaborators, department/group subject grants, inheritance mode, and public link policy.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Share configuration", "403": "Forbidden"},
				false,
			),
			"put": oaOp("Docs", "putDocShare", "Grant or update collaborator permission on a document",
				"Grants, updates, or revokes a user's `view`, `edit`, or `manage` access to the document.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"email": {Type: "string", Description: "Collaborator email", Example: "bob@example.com"},
					"role":  {Type: "string", Description: "Permission level (empty revokes)", Enum: []string{"view", "edit", "manage", ""}},
				}, "email", "role"), "Collaborator permission payload"),
				map[string]string{"200": "Updated share list", "403": "Manage access required"},
				false,
			),
		},
		"/api/docs/{id}/link": map[string]any{
			"put": oaOp("Docs", "putDocLink", "Configure document public share link",
				"Updates public share link visibility (`off`, `view`, `edit`) and copy protection policy.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"access":        {Type: "string", Enum: []string{"off", "view", "edit"}, Example: "view"},
					"copyProtected": {Type: "boolean", Example: false},
				}, "access"), "Share link settings"),
				map[string]string{"200": "Updated share link", "403": "Forbidden"},
				false,
			),
		},
		"/api/docs/{id}/versions": map[string]any{
			"get": oaOp("Docs", "listDocVersions", "List document version snapshots",
				"Returns version history entries for the document.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Version list", "403": "Forbidden"},
				false,
			),
			"post": oaOp("Docs", "createDocVersion", "Save a document version snapshot",
				"Records a new version snapshot of the current document state.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"label": {Type: "string", Description: "Optional version name", Example: "v1.0 Release"},
				}), "Version snapshot metadata"),
				map[string]string{"201": "Version snapshot created", "403": "Forbidden"},
				false,
			),
		},
		"/api/search": map[string]any{
			"get": oaOp("Docs", "searchDocs", "Full-text search across accessible documents",
				"Searches titles and indexed content across workspaces the caller can read.",
				[]map[string]any{
					oaQueryParam("q", "string", "Search query keywords", true),
					oaQueryParam("workspaceId", "integer", "Optional workspace scope", false),
				}, nil,
				map[string]string{"200": "Matching documents", "401": "Unauthorized"},
				false,
			),
		},

		// --- Sheets ---
		"/api/sheets/{id}": map[string]any{
			"get": oaOp("Sheets", "getSheetWorkbook", "Get spreadsheet workbook snapshot",
				"Returns worksheets, cells, styles, merged ranges, defined names, and conditional formats.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Sheet workbook snapshot", "403": "Forbidden", "404": "Not found"},
				false,
			),
		},
		"/api/sheets/{id}/cells": map[string]any{
			"post": oaOp("Sheets", "writeSheetCells", "Batch update spreadsheet cells",
				"Applies cell value, formula, and style updates to a worksheet atomically.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"worksheetId": {Type: "integer", Description: "Target worksheet ID", Example: 1},
					"cells":       {Type: "array", ItemsType: "object", Description: "Cell update operations"},
				}, "worksheetId", "cells"), "Batch cell update payload"),
				map[string]string{"200": "Cells updated", "400": "Invalid cell payload", "403": "Edit access required"},
				false,
			),
		},
		"/api/sheets/{id}/worksheets": map[string]any{
			"post": oaOp("Sheets", "createWorksheet", "Add a worksheet tab to a spreadsheet",
				"Creates a new worksheet tab inside the workbook.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name": {Type: "string", Description: "Worksheet title", Example: "Summary"},
				}, "name"), "Worksheet creation payload"),
				map[string]string{"201": "Worksheet created", "403": "Edit access required"},
				false,
			),
		},
		"/api/sheets/{id}/defined-names": map[string]any{
			"get": oaOp("Sheets", "getSheetDefinedNames", "List spreadsheet defined named ranges",
				"Returns named formula ranges configured on the workbook.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Defined names", "403": "Forbidden"},
				false,
			),
			"put": oaOp("Sheets", "putSheetDefinedNames", "Save spreadsheet defined named ranges",
				"Replaces or updates named formula ranges on the workbook.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"definedNames": {Type: "array", ItemsType: "object", Description: "Named range definitions"},
				}, "definedNames"), "Defined names payload"),
				map[string]string{"200": "Defined names saved", "403": "Edit access required"},
				false,
			),
		},
		"/api/sheets/{id}/versions": map[string]any{
			"get": oaOp("Sheets", "listSheetVersions", "List spreadsheet version snapshots",
				"Returns saved workbook version snapshots.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Sheet versions", "403": "Forbidden"},
				false,
			),
			"post": oaOp("Sheets", "createSheetVersion", "Create spreadsheet version snapshot",
				"Captures a named snapshot of the spreadsheet workbook.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"label": {Type: "string", Example: "Month-End Close"},
				}), "Sheet snapshot label"),
				map[string]string{"201": "Version created", "403": "Edit access required"},
				false,
			),
		},

		// --- Bases (Multi-dimensional tables) ---
		"/api/bases": map[string]any{
			"post": oaOp("Bases", "createBase", "Create a new Base (multi-dimensional table)",
				"Creates a Base document with default table, fields, and grid view.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"workspaceId": {Type: "integer", Example: 1},
					"title":       {Type: "string", Example: "Product Roadmap"},
				}, "workspaceId", "title"), "Base creation payload"),
				map[string]string{"201": "Base created", "403": "Forbidden"},
				false,
			),
		},
		"/api/bases/{id}": map[string]any{
			"get": oaOp("Bases", "getBase", "Get Base schema, views, and records",
				"Returns tables, fields, views, and projected records respecting field-level RBAC.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Base snapshot", "403": "Forbidden", "404": "Not found"},
				false,
			),
		},
		"/api/bases/{id}/records": map[string]any{
			"post": oaOp("Bases", "addBaseRecord", "Insert a record into a Base table",
				"Adds a new row with typed field values and evaluates formulas & automations.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"tableId": {Type: "integer", Description: "Optional table ID inside the Base"},
					"cells":   {Type: "object", Description: "Map of fieldId -> cell value"},
				}, "cells"), "New record payload"),
				map[string]string{"201": "Record inserted", "403": "Forbidden"},
				false,
			),
		},
		"/api/bases/{id}/records/{rid}": map[string]any{
			"patch": oaOp("Bases", "updateBaseRecord", "Update a Base record",
				"Updates one or more cells on an existing Base record.",
				[]map[string]any{docParam, oaPathParam("rid", "Record ID")},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"cells": {Type: "object", Description: "Map of fieldId -> updated cell value"},
				}, "cells"), "Record cell patch"),
				map[string]string{"200": "Record updated", "403": "Forbidden", "404": "Record not found"},
				false,
			),
			"delete": oaOp("Bases", "deleteBaseRecord", "Delete a Base record",
				"Removes the specified record from the Base.",
				[]map[string]any{docParam, oaPathParam("rid", "Record ID")},
				nil,
				map[string]string{"200": "Record deleted", "403": "Forbidden", "404": "Record not found"},
				false,
			),
		},
		"/api/bases/{id}/query": map[string]any{
			"post": oaOp("Bases", "queryBase", "Query Base records with filter, sort, and grouping",
				"Executes a structured query over Base records with filter predicates and sorting.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"viewId": {Type: "integer", Description: "Optional view ID"},
					"filter": {Type: "object", Description: "Filter predicate tree"},
					"sort":   {Type: "array", ItemsType: "object", Description: "Sort clauses"},
				}), "Base query specification"),
				map[string]string{"200": "Matched records", "403": "Forbidden"},
				false,
			),
		},
		"/api/bases/{id}/automations": map[string]any{
			"get": oaOp("Bases", "listBaseAutomations", "List Base automation rules",
				"Lists trigger-action automation workflows configured on the Base.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Automation rules", "403": "Forbidden"},
				false,
			),
			"post": oaOp("Bases", "createBaseAutomation", "Create a Base automation rule",
				"Adds a new trigger-action automation rule (e.g., record created -> notify or call webhook).",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":    {Type: "string", Example: "Notify on High Priority"},
					"trigger": {Type: "object", Description: "Trigger condition definition"},
					"actions": {Type: "array", ItemsType: "object", Description: "Action steps"},
				}, "name", "trigger", "actions"), "Automation rule payload"),
				map[string]string{"201": "Automation created", "403": "Manage access required"},
				false,
			),
		},

		// --- Slides ---
		"/api/slides/{id}/pages": map[string]any{
			"get": oaOp("Slides", "listSlidesPages", "List slides deck pages",
				"Returns ordered slide pages, elements, layouts, and themes for a presentation deck.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Slide pages", "403": "Forbidden"},
				false,
			),
			"post": oaOp("Slides", "createSlidesPage", "Append a new slide page",
				"Creates a new slide page inside the deck.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"title":  {Type: "string", Example: "Architecture Overview"},
					"layout": {Type: "string", Example: "title_and_body"},
				}), "New slide page payload"),
				map[string]string{"201": "Slide page created", "403": "Edit access required"},
				false,
			),
		},
		"/api/slides/{id}/pages/{pid}/content": map[string]any{
			"patch": oaOp("Slides", "patchSlidesPageContent", "Update slide page canvas content",
				"Updates vector elements, text boxes, shapes, and animations on a slide page.",
				[]map[string]any{docParam, oaPathParam("pid", "Slide page ID")},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"elements": {Type: "array", ItemsType: "object", Description: "Canvas element objects"},
				}), "Slide canvas patch"),
				map[string]string{"200": "Slide page updated", "403": "Edit access required"},
				false,
			),
		},
		"/api/slides/{id}/versions": map[string]any{
			"get": oaOp("Slides", "listSlidesVersions", "List slide deck version snapshots",
				"Returns saved version history snapshots of a presentation.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Deck versions", "403": "Forbidden"},
				false,
			),
			"post": oaOp("Slides", "createSlidesVersion", "Create a slide deck version snapshot",
				"Captures a named snapshot of all slides in the presentation.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"label": {Type: "string", Example: "Board Review Final"},
				}), "Deck version label"),
				map[string]string{"201": "Deck version created", "403": "Edit access required"},
				false,
			),
		},

		// --- Drive & Cross-Space Move ---
		"/api/drive/children": map[string]any{
			"get": oaOp("Drive", "listDriveChildren", "List folder children in Drive",
				"Lists folders and documents inside a workspace root or nested folder.",
				[]map[string]any{
					oaQueryParam("workspaceId", "integer", "Workspace ID", true),
					oaQueryParam("parentId", "integer", "Optional parent folder ID (omit for root)", false),
				}, nil,
				map[string]string{"200": "Child nodes", "403": "Forbidden"},
				false,
			),
		},
		"/api/drive/folders": map[string]any{
			"post": oaOp("Drive", "createDriveFolder", "Create a Drive folder",
				"Creates a folder in the specified workspace and optional parent folder.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"workspaceId": {Type: "integer", Example: 1},
					"parentId":    {Type: "integer", Description: "Optional parent folder ID"},
					"title":       {Type: "string", Example: "Engineering Specs"},
				}, "workspaceId", "title"), "Folder creation payload"),
				map[string]string{"201": "Folder created", "403": "Forbidden"},
				false,
			),
		},
		"/api/drive/move/{id}": map[string]any{
			"post": oaOp("Drive", "moveDriveNode", "Move a Drive node within the same workspace",
				"Reparents a folder or document to another folder within the same workspace.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"parentId": {Type: "integer", Description: "Destination parent folder ID (null for root)"},
				}), "Move target payload"),
				map[string]string{"200": "Node moved", "403": "Forbidden", "409": "Cycle or revision conflict"},
				false,
			),
		},
		"/api/drive/cross-space-move/{id}": map[string]any{
			"post": oaOp("Drive", "crossSpaceMoveDriveNode", "Move a Drive node or folder across workspaces",
				"Atomically moves a document or entire folder subtree to another workspace and updates visibility & audit logs.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"targetWorkspaceId": {Type: "integer", Description: "Destination workspace ID", Example: 2},
					"targetParentId":    {Type: "integer", Description: "Optional destination folder ID inside target workspace"},
				}, "targetWorkspaceId"), "Cross-space move target"),
				map[string]string{"200": "Node moved across workspaces", "403": "Insufficient permissions in source or target workspace", "409": "Cycle or conflict"},
				false,
			),
		},
		"/api/drive/trash/{id}": map[string]any{
			"post": oaOp("Drive", "trashDriveNode", "Move a Drive node to trash",
				"Soft-deletes a document or folder subtree into trash.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Node trashed", "403": "Forbidden"},
				false,
			),
		},
		"/api/drive/restore/{id}": map[string]any{
			"post": oaOp("Drive", "restoreDriveNode", "Restore a trashed Drive node",
				"Restores a previously trashed document or folder subtree.",
				[]map[string]any{docParam}, nil,
				map[string]string{"200": "Node restored", "403": "Forbidden"},
				false,
			),
		},

		// --- AI Suite (RAG / Sheet / Base) ---
		"/api/me/ai": map[string]any{
			"get": oaOp("AI Suite", "getAISettings", "Get personal AI provider settings",
				"Returns configured LLM provider endpoint, model name, and masked API key indicator.",
				nil, nil,
				map[string]string{"200": "AI configuration", "401": "Unauthorized"},
				false,
			),
			"put": oaOp("AI Suite", "putAISettings", "Save personal AI provider settings",
				"Encrypts (AES-256-GCM) and stores the caller's OpenAI-compatible provider base URL, model, and API key.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"baseUrl": {Type: "string", Example: "https://api.openai.com/v1"},
					"model":   {Type: "string", Example: "gpt-4o-mini"},
					"apiKey":  {Type: "string", Description: "Provider API key (stored encrypted)"},
				}, "baseUrl", "model"), "AI provider settings"),
				map[string]string{"200": "Settings saved", "400": "Invalid settings"},
				false,
			),
			"delete": oaOp("AI Suite", "deleteAISettings", "Clear personal AI provider settings",
				"Deletes stored AI credentials for the authenticated user.",
				nil, nil,
				map[string]string{"204": "Settings cleared"},
				false,
			),
		},
		"/api/docs/{id}/ai": map[string]any{
			"post": oaOp("AI Suite", "docAI", "Run AI writing assistant on a document",
				"Streams or returns AI-assisted continuation, summarization, translation, or rewriting scoped to the document.",
				[]map[string]any{docParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"action":  {Type: "string", Enum: []string{"summarize", "polish", "translate", "continue", "custom"}, Example: "summarize"},
					"prompt":  {Type: "string", Description: "Optional custom instruction"},
					"context": {Type: "string", Description: "Selected document text"},
				}, "action"), "Document AI action request"),
				map[string]string{"200": "AI generated response", "400": "AI not configured or invalid request", "429": "Rate limit exceeded"},
				false,
			),
		},
		"/api/ai/ask-workspace": map[string]any{
			"post": oaOp("AI Suite", "aiAskWorkspace", "Ask Workspace Knowledge Base (RAG Q&A)",
				"Retrieves permission-filtered documents from the workspace and synthesizes a cited answer via the configured LLM.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"workspaceId": {Type: "integer", Description: "Workspace ID to search", Example: 1},
					"question":    {Type: "string", Description: "Natural-language question", Example: "What is our Q4 release schedule?"},
					"maxSources":  {Type: "integer", Description: "Maximum cited documents (1-10)", Example: 5},
				}, "workspaceId", "question"), "Workspace RAG query"),
				map[string]string{"200": "Answer with cited source documents", "400": "Invalid query or AI unconfigured", "429": "Rate limit exceeded"},
				false,
			),
		},
		"/api/ai/sheet-assist": map[string]any{
			"post": oaOp("AI Suite", "aiSheetAssist", "AI Spreadsheet Formula & Data Analysis Assistant",
				"Generates spreadsheet formulas, explains errors, or summarizes selected cell ranges.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"docId":       {Type: "integer", Description: "Spreadsheet document ID", Example: 10},
					"worksheetId": {Type: "integer", Description: "Worksheet ID", Example: 1},
					"prompt":      {Type: "string", Description: "User request", Example: "Calculate YoY growth rate from column B to C"},
					"range":       {Type: "string", Description: "Optional A1 cell range", Example: "A1:D20"},
				}, "docId", "prompt"), "Sheet AI assist request"),
				map[string]string{"200": "Formula or analysis result", "400": "Invalid request", "429": "Rate limit exceeded"},
				false,
			),
		},
		"/api/ai/base-fill": map[string]any{
			"post": oaOp("AI Suite", "aiBaseFill", "AI Base Field Autofill",
				"Extracts structured tags, summaries, or classifications into a target Base field across selected records.",
				nil,
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"baseId":        {Type: "integer", Description: "Base document ID", Example: 12},
					"targetFieldId": {Type: "integer", Description: "Destination field ID", Example: 4},
					"recordIds":     {Type: "array", ItemsType: "integer", Description: "Records to process"},
					"instruction":   {Type: "string", Description: "Extraction/classification prompt", Example: "Classify priority as High, Medium, or Low"},
				}, "baseId", "targetFieldId", "instruction"), "Base AI autofill request"),
				map[string]string{"200": "Proposed or applied field values", "400": "Invalid request", "429": "Rate limit exceeded"},
				false,
			),
		},

		// --- Organization ---
		"/api/workspaces/{wsId}/org": map[string]any{
			"get": oaOp("Organization", "getWorkspaceOrg", "Get full workspace organization directory",
				"Returns members, roles, hierarchical departments, user groups, and pending invitations (for admins).",
				[]map[string]any{wsParam}, nil,
				map[string]string{"200": "Organization snapshot", "403": "Not a workspace member"},
				false,
			),
		},
		"/api/workspaces/{wsId}/members": map[string]any{
			"post": oaOp("Organization", "upsertWorkspaceMember", "Invite, update role, or remove a workspace member",
				"Invites a non-member by email, updates an existing member's role (`member`/`admin`), or removes (`remove`) them.",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"email": {Type: "string", Example: "new.hire@example.com"},
					"role":  {Type: "string", Enum: []string{"member", "admin", "remove"}, Example: "member"},
				}, "email", "role"), "Member role mutation"),
				map[string]string{"200": "Member updated, invited, or removed", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/departments": map[string]any{
			"post": oaOp("Organization", "createDepartment", "Create an organization department",
				"Creates a top-level or nested child department inside the workspace.",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":     {Type: "string", Example: "Platform Engineering"},
					"parentId": {Type: "integer", Description: "Optional parent department ID"},
				}, "name"), "Department creation payload"),
				map[string]string{"201": "Department created", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/groups": map[string]any{
			"post": oaOp("Organization", "createUserGroup", "Create a workspace user group",
				"Creates an explicit user group for batch permission sharing and SCIM mapping.",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":        {Type: "string", Example: "Security Reviewers"},
					"description": {Type: "string", Example: "Cross-functional security review group"},
				}, "name"), "User group payload"),
				map[string]string{"201": "User group created", "403": "Workspace admin required"},
				false,
			),
		},

		// --- SCIM 2.0 Provisioning (RFC 7643 / 7644) ---
		"/scim/v2/ServiceProviderConfig": map[string]any{
			"get": oaOp("SCIM 2.0", "scimServiceProviderConfig", "Get SCIM 2.0 ServiceProviderConfig",
				"Returns RFC 7643 service provider capabilities (PATCH support, filter support, and Bearer PAT authentication scheme).",
				nil, nil,
				map[string]string{"200": "SCIM ServiceProviderConfig JSON (application/scim+json)"},
				true,
			),
		},
		"/scim/v2/Users": map[string]any{
			"get": oaOp("SCIM 2.0", "scimListUsers", "List or filter provisioned SCIM users",
				"Lists workspace members in RFC 7644 ListResponse format. Requires an admin-scoped PAT and workspace owner/admin role.",
				[]map[string]any{
					scimWSQuery,
					oaQueryParam("filter", "string", `SCIM filter expression, e.g. userName eq "alice@example.com"`, false),
					oaQueryParam("startIndex", "integer", "1-based pagination offset (default 1)", false),
					oaQueryParam("count", "integer", "Max results per page (default 100, max 200)", false),
				}, nil,
				map[string]string{"200": "SCIM ListResponse of Users", "400": "Invalid filter or pagination", "401": "Unauthorized", "403": "Admin PAT & workspace admin required"},
				false,
			),
			"post": oaOp("SCIM 2.0", "scimCreateUser", "Provision a user via SCIM 2.0",
				"Creates a new account (or links an existing account by email) and adds the user to the workspace. Logs `scim.user_provision`.",
				[]map[string]any{scimWSQuery},
				oaSCIMBody(oaObjSchema(map[string]oaProp{
					"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaUser}},
					"userName":    {Type: "string", Description: "Primary email address", Example: "alice@example.com"},
					"displayName": {Type: "string", Example: "Alice Zhang"},
					"active":      {Type: "boolean", Example: true},
					"roles":       {Type: "array", ItemsType: "object", Description: "Workspace roles (member or admin)"},
				}, "userName"), "SCIM 2.0 User resource"),
				map[string]string{"201": "User provisioned", "400": "Invalid SCIM User", "403": "Admin PAT required", "409": "User already exists in workspace"},
				false,
			),
		},
		"/scim/v2/Users/{uid}": map[string]any{
			"get": oaOp("SCIM 2.0", "scimGetUser", "Get a single SCIM 2.0 user",
				"Returns the SCIM 2.0 User resource for a workspace member.",
				[]map[string]any{oaPathParam("uid", "User ID"), scimWSQuery}, nil,
				map[string]string{"200": "SCIM User resource", "404": "User not in workspace"},
				false,
			),
			"patch": oaOp("SCIM 2.0", "scimPatchUser", "Update role or deactivate/deprovision a SCIM user",
				"Applies RFC 7644 PatchOp operations. Setting `active: false` removes the user from the workspace (workspace owners are protected). Updating `roles` updates member role.",
				[]map[string]any{oaPathParam("uid", "User ID"), scimWSQuery},
				oaSCIMBody(oaObjSchema(map[string]oaProp{
					"schemas":    {Type: "array", ItemsType: "string", Example: []string{scimSchemaPatchOp}},
					"Operations": {Type: "array", ItemsType: "object", Description: "SCIM PatchOp operations (replace active / roles)"},
				}, "Operations"), "SCIM PatchOp payload"),
				map[string]string{"200": "Updated or deactivated SCIM User", "403": "Cannot modify/deprovision workspace owner", "404": "User not found"},
				false,
			),
			"delete": oaOp("SCIM 2.0", "scimDeleteUser", "Deprovision a user from the workspace",
				"Removes the user from the workspace and cleans up department/group/wiki grants. Logs `scim.user_deprovision`.",
				[]map[string]any{oaPathParam("uid", "User ID"), scimWSQuery}, nil,
				map[string]string{"204": "User deprovisioned", "403": "Cannot remove workspace owner", "404": "User not found"},
				false,
			),
		},
		"/scim/v2/Groups": map[string]any{
			"get": oaOp("SCIM 2.0", "scimListGroups", "List SCIM 2.0 groups",
				"Lists workspace user groups in RFC 7644 ListResponse format with optional `displayName` filter.",
				[]map[string]any{
					scimWSQuery,
					oaQueryParam("filter", "string", `SCIM filter expression, e.g. displayName eq "Engineering"`, false),
					oaQueryParam("startIndex", "integer", "1-based pagination offset", false),
					oaQueryParam("count", "integer", "Page size (max 200)", false),
				}, nil,
				map[string]string{"200": "SCIM ListResponse of Groups", "403": "Admin PAT required"},
				false,
			),
			"post": oaOp("SCIM 2.0", "scimCreateGroup", "Create a SCIM 2.0 group",
				"Creates a workspace user group and binds initial workspace members.",
				[]map[string]any{scimWSQuery},
				oaSCIMBody(oaObjSchema(map[string]oaProp{
					"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaGroup}},
					"displayName": {Type: "string", Example: "Engineering"},
					"members":     {Type: "array", ItemsType: "object", Description: "Initial member references ({value: userId})"},
				}, "displayName"), "SCIM Group payload"),
				map[string]string{"201": "Group created", "400": "Invalid group or member", "403": "Admin PAT required"},
				false,
			),
		},
		"/scim/v2/Groups/{gid}": map[string]any{
			"get": oaOp("SCIM 2.0", "scimGetGroup", "Get a single SCIM 2.0 group",
				"Returns a single workspace user group with member references.",
				[]map[string]any{oaPathParam("gid", "Group ID"), scimWSQuery}, nil,
				map[string]string{"200": "SCIM Group resource", "404": "Group not found"},
				false,
			),
			"patch": oaOp("SCIM 2.0", "scimPatchGroup", "Rename a SCIM group or modify its members",
				"Applies RFC 7644 PatchOp operations to rename `displayName` or add/remove/replace `members`.",
				[]map[string]any{oaPathParam("gid", "Group ID"), scimWSQuery},
				oaSCIMBody(oaObjSchema(map[string]oaProp{
					"schemas":    {Type: "array", ItemsType: "string", Example: []string{scimSchemaPatchOp}},
					"Operations": {Type: "array", ItemsType: "object", Description: "PatchOp operations for displayName and members"},
				}, "Operations"), "SCIM Group PatchOp payload"),
				map[string]string{"200": "Group updated", "400": "Invalid patch operation", "404": "Group not found"},
				false,
			),
			"delete": oaOp("SCIM 2.0", "scimDeleteGroup", "Delete a SCIM 2.0 group",
				"Deletes the workspace user group and revokes its subject-based document/wiki grants.",
				[]map[string]any{oaPathParam("gid", "Group ID"), scimWSQuery}, nil,
				map[string]string{"204": "Group deleted", "404": "Group not found"},
				false,
			),
		},

		// --- Security, Audit & DLP ---
		"/api/workspaces/{wsId}/audit-logs": map[string]any{
			"get": oaOp("Security & Audit", "listWorkspaceAuditLogs", "Query workspace security audit logs",
				"Filters and paginates security audit events by action, resourceType, actorId, time range, or keyword.",
				[]map[string]any{
					wsParam,
					oaQueryParam("action", "string", "Filter by audit action (e.g. scim.user_provision, auth.login)", false),
					oaQueryParam("resourceType", "string", "Filter by resource type", false),
					oaQueryParam("q", "string", "Full-text keyword filter", false),
					oaQueryParam("limit", "integer", "Page size", false),
					oaQueryParam("offset", "integer", "Pagination offset", false),
				}, nil,
				map[string]string{"200": "Paginated audit log entries", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/audit-logs/export": map[string]any{
			"get": oaOp("Security & Audit", "exportWorkspaceAuditLogs", "Export workspace audit logs as CSV",
				"Streams formula-injection-safe UTF-8 BOM CSV export of matching security audit logs.",
				[]map[string]any{
					wsParam,
					oaQueryParam("action", "string", "Filter by action", false),
					oaQueryParam("from", "string", "Start timestamp (RFC3339 or YYYY-MM-DD)", false),
					oaQueryParam("to", "string", "End timestamp (RFC3339 or YYYY-MM-DD)", false),
				}, nil,
				map[string]string{"200": "CSV attachment download", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/security-policy": map[string]any{
			"get": oaOp("Security & Audit", "getWorkspaceSecurityPolicy", "Get workspace watermark & DLP security policy",
				"Returns watermark configuration and Data Loss Prevention (DLP) policies for the workspace.",
				[]map[string]any{wsParam}, nil,
				map[string]string{"200": "Workspace security policy", "403": "Not a workspace member"},
				false,
			),
			"put": oaOp("Security & Audit", "putWorkspaceSecurityPolicy", "Update workspace watermark & DLP security policy",
				"Configures global document/sheet/base/slides watermark overlay and DLP restrictions (e.g. copy/export/public link controls).",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"watermarkEnabled":   {Type: "boolean", Example: true},
					"watermarkText":      {Type: "string", Example: "CONFIDENTIAL"},
					"watermarkShowUser":  {Type: "boolean", Example: true},
					"watermarkShowEmail": {Type: "boolean", Example: true},
					"watermarkShowDate":  {Type: "boolean", Example: true},
					"watermarkOpacity":   {Type: "number", Example: 0.12},
				}), "Security & DLP policy update"),
				map[string]string{"200": "Updated security policy", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/sso/providers": map[string]any{
			"get": oaOp("Security & Audit", "listWorkspaceSSOProviders", "List workspace SSO identity providers",
				"Lists configured OIDC/OAuth2 enterprise SSO connectors (client secrets are never returned).",
				[]map[string]any{wsParam}, nil,
				map[string]string{"200": "SSO provider list", "403": "Workspace admin required"},
				false,
			),
			"post": oaOp("Security & Audit", "createWorkspaceSSOProvider", "Create a workspace SSO identity provider",
				"Registers an OIDC/OAuth2 IdP (Okta, Azure AD, Keycloak, Feishu, etc.) with encrypted client secret.",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":         {Type: "string", Example: "Okta Corp SSO"},
					"slug":         {Type: "string", Example: "okta-corp"},
					"issuerUrl":    {Type: "string", Example: "https://corp.okta.com/oauth2/default"},
					"clientId":     {Type: "string"},
					"clientSecret": {Type: "string"},
				}, "name", "slug", "issuerUrl", "clientId"), "SSO provider configuration"),
				map[string]string{"201": "SSO provider created", "403": "Workspace admin required"},
				false,
			),
		},

		// --- Webhooks ---
		"/api/workspaces/{wsId}/webhooks": map[string]any{
			"get": oaOp("Webhooks", "listWorkspaceWebhooks", "List workspace event webhooks",
				"Lists all configured outbound HMAC-SHA256 webhooks for the workspace.",
				[]map[string]any{wsParam}, nil,
				map[string]string{"200": "Webhook list", "403": "Workspace admin required"},
				false,
			),
			"post": oaOp("Webhooks", "createWorkspaceWebhook", "Create a workspace event webhook",
				"Creates an outbound webhook subscribing to collaboration events (`doc.created`, `doc.deleted`, `share.updated`, `base.record_mutated`, `sheet.cells_updated`, `slides.version_created`). Returns signing secret once.",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":    {Type: "string", Example: "Enterprise Event Bus"},
					"url":     {Type: "string", Example: "https://hooks.example.com/jiange"},
					"events":  {Type: "array", ItemsType: "string", Example: []string{"doc.created", "share.updated"}},
					"enabled": {Type: "boolean", Example: true},
				}, "name", "url", "events"), "Webhook creation payload"),
				map[string]string{"201": "Webhook created with signing secret", "400": "Invalid URL or events", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/webhooks/{wid}": map[string]any{
			"patch": oaOp("Webhooks", "updateWorkspaceWebhook", "Update a workspace webhook",
				"Updates webhook name, target URL, subscribed events, enabled state, or rotates signing secret.",
				[]map[string]any{wsParam, oaPathParam("wid", "Webhook ID")},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":    {Type: "string"},
					"url":     {Type: "string"},
					"events":  {Type: "array", ItemsType: "string"},
					"enabled": {Type: "boolean"},
				}), "Webhook update payload"),
				map[string]string{"200": "Webhook updated", "404": "Webhook not found"},
				false,
			),
			"delete": oaOp("Webhooks", "deleteWorkspaceWebhook", "Delete a workspace webhook",
				"Deletes the webhook and stops event deliveries.",
				[]map[string]any{wsParam, oaPathParam("wid", "Webhook ID")}, nil,
				map[string]string{"204": "Webhook deleted", "404": "Webhook not found"},
				false,
			),
		},
		"/api/workspaces/{wsId}/webhooks/{wid}/test": map[string]any{
			"post": oaOp("Webhooks", "testWorkspaceWebhook", "Send a signed test webhook event",
				"Dispatches a `webhook.test` event signed with `X-Jiange-Signature` and returns HTTP status & latency.",
				[]map[string]any{wsParam, oaPathParam("wid", "Webhook ID")}, nil,
				map[string]string{"200": "Test delivery result", "404": "Webhook not found"},
				false,
			),
		},
		"/api/workspaces/{wsId}/webhooks/{wid}/deliveries": map[string]any{
			"get": oaOp("Webhooks", "listWebhookDeliveries", "List recent webhook delivery logs",
				"Returns recent delivery attempts, HTTP status codes, retries, and response snippets.",
				[]map[string]any{wsParam, oaPathParam("wid", "Webhook ID")}, nil,
				map[string]string{"200": "Delivery history", "404": "Webhook not found"},
				false,
			),
		},

		// --- External Notification Channels ---
		"/api/workspaces/{wsId}/notification-channels": map[string]any{
			"get": oaOp("Notification Channels", "listNotificationChannels", "List external notification channels",
				"Lists configured SMTP email and IM bot (Feishu, DingTalk, WeCom, Slack) notification channels with masked config hints.",
				[]map[string]any{wsParam}, nil,
				map[string]string{"200": "Notification channel list", "403": "Workspace admin required"},
				false,
			),
			"post": oaOp("Notification Channels", "createNotificationChannel", "Create an external notification channel",
				"Encrypts credentials with AES-256-GCM and creates an SMTP or IM bot notification channel.",
				[]map[string]any{wsParam},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":    {Type: "string", Example: "Engineering Feishu Alerts"},
					"kind":    {Type: "string", Enum: []string{"smtp", "feishu_bot", "dingtalk_bot", "wecom_bot", "slack_bot"}, Example: "feishu_bot"},
					"config":  {Type: "object", Description: "Channel-specific encrypted connection config"},
					"events":  {Type: "array", ItemsType: "string", Example: []string{"mention", "comment_reply", "automation"}},
					"enabled": {Type: "boolean", Example: true},
				}, "name", "kind", "config", "events"), "Notification channel payload"),
				map[string]string{"201": "Channel created", "400": "Invalid channel config", "403": "Workspace admin required"},
				false,
			),
		},
		"/api/workspaces/{wsId}/notification-channels/{cid}": map[string]any{
			"patch": oaOp("Notification Channels", "updateNotificationChannel", "Update an external notification channel",
				"Updates channel name, events, enabled toggle, or encrypted connection credentials.",
				[]map[string]any{wsParam, oaPathParam("cid", "Notification channel ID")},
				oaJSONBody(oaObjSchema(map[string]oaProp{
					"name":    {Type: "string"},
					"events":  {Type: "array", ItemsType: "string"},
					"enabled": {Type: "boolean"},
					"config":  {Type: "object"},
				}), "Channel update payload"),
				map[string]string{"200": "Channel updated", "404": "Channel not found"},
				false,
			),
			"delete": oaOp("Notification Channels", "deleteNotificationChannel", "Delete an external notification channel",
				"Removes the notification channel and stops external pushes.",
				[]map[string]any{wsParam, oaPathParam("cid", "Notification channel ID")}, nil,
				map[string]string{"204": "Channel deleted", "404": "Channel not found"},
				false,
			),
		},
		"/api/workspaces/{wsId}/notification-channels/{cid}/test": map[string]any{
			"post": oaOp("Notification Channels", "testNotificationChannel", "Send a test notification to a channel",
				"Dispatches a live connectivity test message to the configured SMTP server or IM bot.",
				[]map[string]any{wsParam, oaPathParam("cid", "Notification channel ID")}, nil,
				map[string]string{"200": "Test dispatch result with latency", "404": "Channel not found"},
				false,
			),
		},

		// --- Developer / OpenAPI Spec ---
		"/api/openapi.json": map[string]any{
			"get": oaOp("Developer", "getOpenAPISpec", "Get OpenAPI 3.1.0 JSON specification",
				"Returns the complete machine-readable OpenAPI 3.1.0 specification for Jiange Open API and SCIM 2.0.",
				nil, nil,
				map[string]string{"200": "OpenAPI 3.1.0 JSON document"},
				true,
			),
		},
	}

	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":   "Jiange Open API",
			"version": "0.2.0",
			"description": "Jiange collaborative office suite Open API covering Authentication & MFA/SSO, Personal Access Tokens (PAT), " +
				"Docs, Sheets, Bases, Slides, Drive & Cross-Space Move, AI Suite (Workspace RAG, Sheet Assist, Base Autofill), " +
				"Organization & RFC 7643/7644 SCIM 2.0 Provisioning, Security Audit & DLP Policies, Webhooks, and External Notification Channels.",
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
			{"name": "Auth & MFA", "description": "Account authentication, TOTP two-factor authentication, and enterprise SSO"},
			{"name": "Personal Access Tokens", "description": "Bearer Personal Access Token (jg_pat_...) lifecycle and scopes"},
			{"name": "Docs", "description": "Collaborative documents, sharing ACLs, public links, versions, and full-text search"},
			{"name": "Sheets", "description": "Multi-worksheet spreadsheets, batch cell writes, defined names, and versions"},
			{"name": "Bases", "description": "Multi-dimensional tables, structured queries, records, and automation rules"},
			{"name": "Slides", "description": "Presentation decks, slide canvas pages, and version snapshots"},
			{"name": "Drive", "description": "Workspace folders, hierarchy navigation, trash/restore, and cross-space move"},
			{"name": "AI Suite", "description": "Encrypted AI provider config, Document AI, Workspace RAG Q&A, Sheet Assist, and Base Autofill"},
			{"name": "Organization", "description": "Workspace members, roles, hierarchical departments, and user groups"},
			{"name": "SCIM 2.0", "description": "RFC 7643 / 7644 SCIM 2.0 user and group provisioning for Okta, Azure AD, and Feishu"},
			{"name": "Security & Audit", "description": "Security audit logs, CSV export, watermark & DLP policies, and SSO IdP management"},
			{"name": "Webhooks", "description": "HMAC-SHA256 signed workspace event webhooks and delivery history"},
			{"name": "Notification Channels", "description": "External SMTP email and Feishu/DingTalk/WeCom/Slack bot alert channels"},
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
			"schemas": map[string]any{
				"ErrorResponse": oaObjSchema(map[string]oaProp{
					"error":   {Type: "string", Example: "forbidden"},
					"message": {Type: "string", Example: "Insufficient permissions"},
				}, "error", "message"),
				"SCIMError": oaObjSchema(map[string]oaProp{
					"schemas":  {Type: "array", ItemsType: "string", Example: []string{scimSchemaError}},
					"scimType": {Type: "string", Example: "invalidValue"},
					"detail":   {Type: "string", Example: "Resource not found"},
					"status":   {Type: "string", Example: "404"},
				}, "schemas", "detail", "status"),
				"SCIMUser": oaObjSchema(map[string]oaProp{
					"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaUser}},
					"id":          {Type: "string", Example: "42"},
					"userName":    {Type: "string", Example: "alice@example.com"},
					"displayName": {Type: "string", Example: "Alice Zhang"},
					"active":      {Type: "boolean", Example: true},
					"emails":      {Type: "array", ItemsType: "object"},
					"roles":       {Type: "array", ItemsType: "object"},
					"groups":      {Type: "array", ItemsType: "object"},
				}, "schemas", "id", "userName", "active"),
				"SCIMGroup": oaObjSchema(map[string]oaProp{
					"schemas":     {Type: "array", ItemsType: "string", Example: []string{scimSchemaGroup}},
					"id":          {Type: "string", Example: "7"},
					"displayName": {Type: "string", Example: "Engineering"},
					"members":     {Type: "array", ItemsType: "object"},
				}, "schemas", "id", "displayName", "members"),
				"PersonalAccessToken": oaObjSchema(map[string]oaProp{
					"id":          {Type: "integer", Example: 1},
					"name":        {Type: "string", Example: "Okta SCIM"},
					"tokenPrefix": {Type: "string", Example: "jg_pat_AbCdEfG"},
					"scopes":      {Type: "array", ItemsType: "string", Example: []string{"read", "write", "admin"}},
					"createdAt":   {Type: "string", Example: "2026-11-24T10:00:00Z"},
				}, "id", "name", "tokenPrefix", "scopes"),
			},
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
