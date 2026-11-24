package api

import (
	"bytes"
	"compress/flate"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func generateTestRSAIdP(t *testing.T, cn string) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create rsa cert: %v", err)
	}
	certPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return key, certPEM
}

func generateTestECDSAIdP(t *testing.T, cn string) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ecdsa key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create ecdsa cert: %v", err)
	}
	certPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return key, certPEM
}

func newSAMLTestServer(t *testing.T, st store.Store, configure func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:        st,
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL:   time.Hour,
		Iterations:   1000,
		SSOAllowHTTP: true,
	}
	if configure != nil {
		configure(s)
	}
	jsonMux := http.NewServeMux()
	jsonMux.HandleFunc("POST /api/auth/register", s.register)
	jsonMux.HandleFunc("POST /api/auth/login", s.login)
	jsonMux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	jsonMux.Handle("GET /api/workspaces/{wsId}/audit-logs", s.requireUser(http.HandlerFunc(s.listWorkspaceAuditLogs)))
	jsonMux.HandleFunc("GET /api/auth/sso/providers", s.listPublicSSOProviders)
	jsonMux.HandleFunc("GET /api/auth/sso/{slug}/start", s.startSSO)
	jsonMux.HandleFunc("GET /api/auth/sso/{slug}/callback", s.callbackSSO)
	jsonMux.HandleFunc("GET /api/auth/sso/{slug}/metadata.xml", s.samlMetadata)
	jsonMux.Handle("GET /api/workspaces/{wsId}/sso/providers", s.requireUser(http.HandlerFunc(s.listWorkspaceSSOProviders)))
	jsonMux.Handle("POST /api/workspaces/{wsId}/sso/providers", s.requireUser(http.HandlerFunc(s.createWorkspaceSSOProvider)))
	jsonMux.Handle("PATCH /api/workspaces/{wsId}/sso/providers/{pid}", s.requireUser(http.HandlerFunc(s.updateWorkspaceSSOProvider)))
	jsonMux.Handle("DELETE /api/workspaces/{wsId}/sso/providers/{pid}", s.requireUser(http.HandlerFunc(s.deleteWorkspaceSSOProvider)))

	// Wrap standard JSON endpoints with RequireJSON, while mounting SAML HTTP-POST ACS
	// endpoint with form-urlencoded support (matching SAML 2.0 HTTP-POST binding).
	topMux := http.NewServeMux()
	topMux.HandleFunc("POST /api/auth/sso/{slug}/acs", s.acsSAML)
	topMux.Handle("/", httpx.RequireJSON(jsonMux))

	handler := httpx.Chain(topMux,
		httpx.WithRequestID,
		httpx.Logger(s.Log),
		httpx.Recover(s.Log),
		httpx.SecurityHeaders,
	)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return s, ts
}

type testSAMLResponseOpts struct {
	ResponseID    string
	AssertionID   string
	InResponseTo  string
	Destination   string
	Issuer        string
	StatusCode    string
	NameID        string
	NotBefore     time.Time
	NotOnOrAfter  time.Time
	Audience      string
	Attributes    map[string]string
	ExtraRawChild string
}

func buildUnsignedSAMLResponseXML(o testSAMLResponseOpts) []byte {
	if o.ResponseID == "" {
		o.ResponseID = "resp_1"
	}
	if o.AssertionID == "" {
		o.AssertionID = "assert_1"
	}
	if o.StatusCode == "" {
		o.StatusCode = samlStatusSuccess
	}
	if o.Issuer == "" {
		o.Issuer = "https://idp.example.com/saml/metadata"
	}
	issueInstant := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	var b strings.Builder
	b.WriteString(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`)
	fmt.Fprintf(&b, ` ID="%s" Version="2.0" IssueInstant="%s"`, xmlEscapeString(o.ResponseID), issueInstant)
	if o.InResponseTo != "" {
		fmt.Fprintf(&b, ` InResponseTo="%s"`, xmlEscapeString(o.InResponseTo))
	}
	if o.Destination != "" {
		fmt.Fprintf(&b, ` Destination="%s"`, xmlEscapeString(o.Destination))
	}
	b.WriteString(`>`)
	fmt.Fprintf(&b, `<saml:Issuer>%s</saml:Issuer>`, xmlEscapeString(o.Issuer))
	fmt.Fprintf(&b, `<samlp:Status><samlp:StatusCode Value="%s"/></samlp:Status>`, xmlEscapeString(o.StatusCode))

	fmt.Fprintf(&b, `<saml:Assertion ID="%s" Version="2.0" IssueInstant="%s">`, xmlEscapeString(o.AssertionID), issueInstant)
	fmt.Fprintf(&b, `<saml:Issuer>%s</saml:Issuer>`, xmlEscapeString(o.Issuer))

	b.WriteString(`<saml:Subject>`)
	if o.NameID != "" {
		fmt.Fprintf(&b, `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">%s</saml:NameID>`, xmlEscapeString(o.NameID))
	}
	b.WriteString(`<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData`)
	if o.InResponseTo != "" {
		fmt.Fprintf(&b, ` InResponseTo="%s"`, xmlEscapeString(o.InResponseTo))
	}
	if o.Destination != "" {
		fmt.Fprintf(&b, ` Recipient="%s"`, xmlEscapeString(o.Destination))
	}
	if !o.NotOnOrAfter.IsZero() {
		fmt.Fprintf(&b, ` NotOnOrAfter="%s"`, o.NotOnOrAfter.UTC().Format("2006-01-02T15:04:05Z"))
	}
	b.WriteString(`/></saml:SubjectConfirmation></saml:Subject>`)

	b.WriteString(`<saml:Conditions`)
	if !o.NotBefore.IsZero() {
		fmt.Fprintf(&b, ` NotBefore="%s"`, o.NotBefore.UTC().Format("2006-01-02T15:04:05Z"))
	}
	if !o.NotOnOrAfter.IsZero() {
		fmt.Fprintf(&b, ` NotOnOrAfter="%s"`, o.NotOnOrAfter.UTC().Format("2006-01-02T15:04:05Z"))
	}
	b.WriteString(`>`)
	if o.Audience != "" {
		fmt.Fprintf(&b, `<saml:AudienceRestriction><saml:Audience>%s</saml:Audience></saml:AudienceRestriction>`, xmlEscapeString(o.Audience))
	}
	b.WriteString(`</saml:Conditions>`)

	if len(o.Attributes) > 0 {
		b.WriteString(`<saml:AttributeStatement>`)
		for k, v := range o.Attributes {
			fmt.Fprintf(&b, `<saml:Attribute Name="%s"><saml:AttributeValue>%s</saml:AttributeValue></saml:Attribute>`,
				xmlEscapeString(k), xmlEscapeString(v))
		}
		b.WriteString(`</saml:AttributeStatement>`)
	}
	b.WriteString(`</saml:Assertion>`)
	if o.ExtraRawChild != "" {
		b.WriteString(o.ExtraRawChild)
	}
	b.WriteString(`</samlp:Response>`)
	return []byte(b.String())
}

func postSAMLACS(t *testing.T, c *http.Client, acsURL string, samlRespXML []byte, relayState string) *http.Response {
	t.Helper()
	form := url.Values{}
	form.Set("SAMLResponse", base64.StdEncoding.EncodeToString(samlRespXML))
	if relayState != "" {
		form.Set("RelayState", relayState)
	}
	req, err := http.NewRequest(http.MethodPost, acsURL, strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func inflateSAMLRequest(t *testing.T, encoded string) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("base64 decode SAMLRequest: %v", err)
	}
	r := flate.NewReader(bytes.NewReader(raw))
	defer r.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("flate inflate SAMLRequest: %v", err)
	}
	return out
}

func registerOwnerAndWS(t *testing.T, c *http.Client, baseURL string) int64 {
	t.Helper()
	regRes := post(t, c, baseURL+"/api/auth/register", map[string]string{
		"email": "saml-owner@corp.example.com", "name": "SAML Owner", "password": "password123",
	})
	var me meResponse
	if err := json.NewDecoder(regRes.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	return me.Workspaces[0].ID
}

func TestSAMLAdminCRUDAndMetadata(t *testing.T) {
	_, certPEM := generateTestRSAIdP(t, "idp.example.com")
	mem := store.NewMemory()
	_, ts := newSAMLTestServer(t, mem, nil)

	ownerClient := newSSOCookieClient(false)
	wsID := registerOwnerAndWS(t, ownerClient, ts.URL)
	wsBase := fmt.Sprintf("%s/api/workspaces/%d/sso", ts.URL, wsID)

	// Invalid PEM cert must be rejected with 400.
	badCertRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "bad-saml",
		"name":           "Bad SAML",
		"providerType":   "saml",
		"samlSsoUrl":     "https://idp.example.com/saml/sso",
		"samlIdpCertPem": "not-a-valid-certificate",
	})
	if badCertRes.StatusCode != http.StatusBadRequest {
		raw, _ := io.ReadAll(badCertRes.Body)
		t.Fatalf("invalid PEM status=%d body=%s, want 400", badCertRes.StatusCode, raw)
	}

	// Missing samlSsoUrl must be rejected with 400.
	noURLRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "no-url-saml",
		"name":           "No URL SAML",
		"providerType":   "saml",
		"samlIdpCertPem": certPEM,
	})
	if noURLRes.StatusCode != http.StatusBadRequest {
		raw, _ := io.ReadAll(noURLRes.Body)
		t.Fatalf("missing samlSsoUrl status=%d body=%s, want 400", noURLRes.StatusCode, raw)
	}

	// Valid SAML provider creation (no authUrl / tokenUrl / clientId required).
	createRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "okta-saml",
		"name":           "Okta SAML 2.0",
		"providerType":   "saml",
		"enabled":        true,
		"samlEntityId":   "https://idp.example.com/saml/metadata",
		"samlSsoUrl":     "https://idp.example.com/saml/sso",
		"samlIdpCertPem": certPEM,
		"autoCreateUser": true,
		"defaultRole":    "member",
		"allowedDomains": "corp.example.com",
	})
	rawCreated, _ := io.ReadAll(createRes.Body)
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create SAML status=%d body=%s", createRes.StatusCode, rawCreated)
	}
	var created store.SSOProvider
	_ = json.Unmarshal(rawCreated, &created)
	if created.ProviderType != "saml" || created.SAMLSsoURL != "https://idp.example.com/saml/sso" ||
		created.SAMLAttributeEmail != "email" || created.SAMLAttributeName != "displayName" {
		t.Fatalf("unexpected created SAML provider: %+v", created)
	}

	// GET /api/auth/sso/okta-saml/metadata.xml returns valid SP metadata XML.
	metaReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/auth/sso/okta-saml/metadata.xml", nil)
	metaReq.Header.Set("X-Forwarded-Proto", "https")
	metaReq.Header.Set("X-Forwarded-Host", "docs.corp.example.com")
	metaRes, err := http.DefaultClient.Do(metaReq)
	if err != nil {
		t.Fatal(err)
	}
	metaBody, _ := io.ReadAll(metaRes.Body)
	if metaRes.StatusCode != http.StatusOK {
		t.Fatalf("metadata status=%d body=%s", metaRes.StatusCode, metaBody)
	}
	if ct := metaRes.Header.Get("Content-Type"); !strings.Contains(ct, "application/samlmetadata+xml") {
		t.Fatalf("metadata Content-Type = %q", ct)
	}
	var parsedMeta struct {
		XMLName  xml.Name `xml:"EntityDescriptor"`
		EntityID string   `xml:"entityID,attr"`
		SP       struct {
			AuthnRequestsSigned  string `xml:"AuthnRequestsSigned,attr"`
			WantAssertionsSigned string `xml:"WantAssertionsSigned,attr"`
			ProtocolSupport      string `xml:"protocolSupportEnumeration,attr"`
			ACS                  struct {
				Binding   string `xml:"Binding,attr"`
				Location  string `xml:"Location,attr"`
				Index     string `xml:"index,attr"`
				IsDefault string `xml:"isDefault,attr"`
			} `xml:"AssertionConsumerService"`
		} `xml:"SPSSODescriptor"`
	}
	if err := xml.Unmarshal(metaBody, &parsedMeta); err != nil {
		t.Fatalf("parse metadata XML: %v\n%s", err, metaBody)
	}
	if parsedMeta.EntityID != "https://docs.corp.example.com/api/auth/sso/okta-saml/metadata.xml" ||
		parsedMeta.SP.AuthnRequestsSigned != "false" ||
		parsedMeta.SP.WantAssertionsSigned != "true" ||
		parsedMeta.SP.ProtocolSupport != "urn:oasis:names:tc:SAML:2.0:protocol" ||
		parsedMeta.SP.ACS.Binding != "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ||
		parsedMeta.SP.ACS.Location != "https://docs.corp.example.com/api/auth/sso/okta-saml/acs" ||
		parsedMeta.SP.ACS.Index != "0" ||
		parsedMeta.SP.ACS.IsDefault != "true" {
		t.Fatalf("unexpected SP metadata parsed: %+v\nraw:\n%s", parsedMeta, metaBody)
	}

	// Custom SAMLSpEntityID overrides default entityID in metadata.xml.
	patchRes := doJSONReq(t, ownerClient, http.MethodPatch, fmt.Sprintf("%s/providers/%d", wsBase, created.ID), map[string]any{
		"samlSpEntityId": "urn:jiange:sp:acme",
	})
	if patchRes.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(patchRes.Body)
		t.Fatalf("patch samlSpEntityId status=%d body=%s", patchRes.StatusCode, raw)
	}
	metaRes2, err := http.Get(ts.URL + "/api/auth/sso/okta-saml/metadata.xml")
	if err != nil {
		t.Fatal(err)
	}
	metaBody2, _ := io.ReadAll(metaRes2.Body)
	if !strings.Contains(string(metaBody2), `entityID="urn:jiange:sp:acme"`) {
		t.Fatalf("metadata did not use custom samlSpEntityId: %s", metaBody2)
	}

	// Invalid PEM on PATCH is rejected with 400.
	badPatch := doJSONReq(t, ownerClient, http.MethodPatch, fmt.Sprintf("%s/providers/%d", wsBase, created.ID), map[string]any{
		"samlIdpCertPem": "-----BEGIN PRIVATE KEY-----\nbogus\n-----END PRIVATE KEY-----",
	})
	if badPatch.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad cert patch status=%d, want 400", badPatch.StatusCode)
	}

	// Metadata returns 404 for unknown slug and for OIDC providers.
	if res, _ := http.Get(ts.URL + "/api/auth/sso/missing-slug/metadata.xml"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("missing slug metadata status=%d, want 404", res.StatusCode)
	}
	oidcCreate := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug": "not-saml", "name": "OIDC", "providerType": "oidc",
		"authUrl": "https://idp.example.com/a", "tokenUrl": "https://idp.example.com/t", "clientId": "cid",
	})
	if oidcCreate.StatusCode != http.StatusCreated {
		t.Fatalf("create oidc status=%d", oidcCreate.StatusCode)
	}
	if res, _ := http.Get(ts.URL + "/api/auth/sso/not-saml/metadata.xml"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("oidc provider metadata status=%d, want 404", res.StatusCode)
	}
}

func TestSAMLStartAndEndToEndRSASHA256Login(t *testing.T) {
	rsaKey, certPEM := generateTestRSAIdP(t, "idp.corp.example.com")
	mem := store.NewMemory()
	now := time.Now().UTC().Truncate(time.Second)

	_, ts := newSAMLTestServer(t, mem, func(s *Server) {
		s.Now = func() time.Time { return now }
	})

	ownerClient := newSSOCookieClient(false)
	wsID := registerOwnerAndWS(t, ownerClient, ts.URL)
	wsBase := fmt.Sprintf("%s/api/workspaces/%d/sso", ts.URL, wsID)

	createRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "corp-saml",
		"name":           "Corp SAML",
		"providerType":   "saml",
		"enabled":        true,
		"samlEntityId":   "https://idp.corp.example.com/metadata",
		"samlSsoUrl":     "https://idp.corp.example.com/sso/saml",
		"samlIdpCertPem": certPEM,
		"samlSpEntityId": "urn:jiange:sp:corp",
		"autoCreateUser": true,
		"defaultRole":    "member",
		"allowedDomains": "corp.example.com",
	})
	if createRes.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(createRes.Body)
		t.Fatalf("create saml status=%d body=%s", createRes.StatusCode, raw)
	}

	// 1. GET /api/auth/sso/corp-saml/start -> 302 redirect with deflated+base64 SAMLRequest.
	userClient := newSSOCookieClient(true)
	startRes, err := userClient.Get(ts.URL + "/api/auth/sso/corp-saml/start?redirect=/%23/org")
	if err != nil {
		t.Fatal(err)
	}
	if startRes.StatusCode != http.StatusFound {
		t.Fatalf("start status=%d, want 302", startRes.StatusCode)
	}
	locU, err := url.Parse(startRes.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if locU.Scheme != "https" || locU.Host != "idp.corp.example.com" || locU.Path != "/sso/saml" {
		t.Fatalf("unexpected IdP redirect URL: %s", locU.String())
	}
	samlReqParam := locU.Query().Get("SAMLRequest")
	relayState := locU.Query().Get("RelayState")
	if samlReqParam == "" || !strings.HasPrefix(relayState, "id_") {
		t.Fatalf("missing SAMLRequest or RelayState: %s", locU.String())
	}

	inflatedXML := inflateSAMLRequest(t, samlReqParam)
	var authnReq struct {
		XMLName         xml.Name `xml:"AuthnRequest"`
		ID              string   `xml:"ID,attr"`
		Version         string   `xml:"Version,attr"`
		IssueInstant    string   `xml:"IssueInstant,attr"`
		Destination     string   `xml:"Destination,attr"`
		ACSURL          string   `xml:"AssertionConsumerServiceURL,attr"`
		ProtocolBinding string   `xml:"ProtocolBinding,attr"`
		Issuer          string   `xml:"Issuer"`
	}
	if err := xml.Unmarshal(inflatedXML, &authnReq); err != nil {
		t.Fatalf("parse AuthnRequest XML: %v\n%s", err, inflatedXML)
	}
	expectedACS := ts.URL + "/api/auth/sso/corp-saml/acs"
	if authnReq.ID != relayState || authnReq.Version != "2.0" ||
		authnReq.Destination != "https://idp.corp.example.com/sso/saml" ||
		authnReq.ACSURL != expectedACS ||
		authnReq.ProtocolBinding != samlBindingHTTPPost ||
		authnReq.Issuer != "urn:jiange:sp:corp" {
		t.Fatalf("unexpected AuthnRequest fields: %+v", authnReq)
	}

	// 2. Build genuinely RSA-SHA256 signed SAMLResponse and POST to ACS.
	unsignedXML := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		ResponseID:   "resp_e2e_1",
		AssertionID:  "assert_e2e_1",
		InResponseTo: authnReq.ID,
		Destination:  expectedACS,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "saml-sub-alice-001",
		NotBefore:    now.Add(-1 * time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:corp",
		Attributes: map[string]string{
			"email":       "Alice.Wang@Corp.Example.com",
			"displayName": "Alice Wang",
		},
	})
	signedXML, err := SignSAMLAssertionForTest(certPEM, rsaKey, unsignedXML)
	if err != nil {
		t.Fatalf("SignSAMLAssertionForTest: %v", err)
	}

	acsRes := postSAMLACS(t, userClient, expectedACS, signedXML, relayState)
	if acsRes.StatusCode != http.StatusFound || acsRes.Header.Get("Location") != "/#/org" {
		t.Fatalf("ACS status=%d loc=%q, want 302 to /#/org", acsRes.StatusCode, acsRes.Header.Get("Location"))
	}

	// 3. Session cookie authenticates JIT-provisioned user & grants workspace membership.
	meRes, err := userClient.Get(ts.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	if meRes.StatusCode != http.StatusOK {
		t.Fatalf("me after SAML status=%d", meRes.StatusCode)
	}
	var aliceMe meResponse
	_ = json.NewDecoder(meRes.Body).Decode(&aliceMe)
	if aliceMe.User.Email != "alice.wang@corp.example.com" || aliceMe.User.Name != "Alice Wang" || len(aliceMe.Workspaces) != 2 {
		t.Fatalf("unexpected JIT user /api/me: %+v", aliceMe)
	}
	joinedTarget := false
	for _, w := range aliceMe.Workspaces {
		if w.ID == wsID {
			joinedTarget = true
		}
	}
	if !joinedTarget {
		t.Fatalf("user did not join target workspace %d: %+v", wsID, aliceMe.Workspaces)
	}

	// 4. Verify auth.saml_login audit log was recorded.
	auditRes, err := ownerClient.Get(fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=auth.saml_login", ts.URL, wsID))
	if err != nil {
		t.Fatal(err)
	}
	if auditRes.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(auditRes.Body)
		t.Fatalf("audit logs status=%d body=%s", auditRes.StatusCode, raw)
	}
	var auditPage store.AuditLogPage
	_ = json.NewDecoder(auditRes.Body).Decode(&auditPage)
	if len(auditPage.Items) == 0 || auditPage.Items[0].Action != "auth.saml_login" || auditPage.Items[0].ActorEmail != "alice.wang@corp.example.com" {
		t.Fatalf("expected auth.saml_login audit entry, got: %+v", auditPage.Items)
	}

	// 5. Also verify Response-level signature + standard WS-Federation claim URI & givenName/sn fallback.
	startRes2, _ := userClient.Get(ts.URL + "/api/auth/sso/corp-saml/start")
	loc2, _ := url.Parse(startRes2.Header.Get("Location"))
	reqID2 := loc2.Query().Get("RelayState")
	unsignedRespSig := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		ResponseID:   "resp_signed_root",
		AssertionID:  "assert_inside_signed_root",
		InResponseTo: reqID2,
		Destination:  expectedACS,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "saml-sub-bob-002",
		NotBefore:    now.Add(-1 * time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:corp",
		Attributes: map[string]string{
			"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "bob@corp.example.com",
			"givenName": "Bob",
			"sn":        "Li",
		},
	})
	signedRootXML, err := signSAMLElement(certPEM, rsaKey, unsignedRespSig, "Response", algRSASHA1, algDigestSHA1)
	if err != nil {
		t.Fatalf("sign Response with RSA-SHA1: %v", err)
	}
	bobClient := newSSOCookieClient(true)
	bobACS := postSAMLACS(t, bobClient, expectedACS, signedRootXML, reqID2)
	if bobACS.StatusCode != http.StatusFound || bobACS.Header.Get("Location") != "/#/" {
		t.Fatalf("Response-signed RSA-SHA1 ACS status=%d loc=%q", bobACS.StatusCode, bobACS.Header.Get("Location"))
	}
	bobMeRes, _ := bobClient.Get(ts.URL + "/api/me")
	var bobMe meResponse
	_ = json.NewDecoder(bobMeRes.Body).Decode(&bobMe)
	if bobMe.User.Email != "bob@corp.example.com" || bobMe.User.Name != "Bob Li" {
		t.Fatalf("unexpected Bob profile: %+v", bobMe.User)
	}
}

func TestSAMLECDSASHA256Login(t *testing.T) {
	ecKey, ecCertPEM := generateTestECDSAIdP(t, "ec-idp.example.com")
	mem := store.NewMemory()
	now := time.Now().UTC().Truncate(time.Second)

	_, ts := newSAMLTestServer(t, mem, func(s *Server) {
		s.Now = func() time.Time { return now }
	})
	ownerClient := newSSOCookieClient(false)
	wsID := registerOwnerAndWS(t, ownerClient, ts.URL)
	wsBase := fmt.Sprintf("%s/api/workspaces/%d/sso", ts.URL, wsID)

	createRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "ec-saml",
		"name":           "ECDSA SAML",
		"providerType":   "saml",
		"samlSsoUrl":     "https://ec-idp.example.com/sso",
		"samlIdpCertPem": ecCertPEM,
		"autoCreateUser": true,
	})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create ec saml status=%d", createRes.StatusCode)
	}

	c := newSSOCookieClient(true)
	startRes, _ := c.Get(ts.URL + "/api/auth/sso/ec-saml/start")
	loc, _ := url.Parse(startRes.Header.Get("Location"))
	reqID := loc.Query().Get("RelayState")
	expectedACS := ts.URL + "/api/auth/sso/ec-saml/acs"

	unsigned := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		ResponseID:   "resp_ec",
		AssertionID:  "assert_ec",
		InResponseTo: reqID,
		Destination:  expectedACS,
		NameID:       "carol@ec.example.com", // Email fallback from NameID
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
	})
	signed, err := SignSAMLAssertionForTest(ecCertPEM, ecKey, unsigned)
	if err != nil {
		t.Fatalf("sign ECDSA: %v", err)
	}
	res := postSAMLACS(t, c, expectedACS, signed, reqID)
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/#/" {
		t.Fatalf("ECDSA ACS status=%d loc=%q", res.StatusCode, res.Header.Get("Location"))
	}
	meRes, _ := c.Get(ts.URL + "/api/me")
	var me meResponse
	_ = json.NewDecoder(meRes.Body).Decode(&me)
	if me.User.Email != "carol@ec.example.com" {
		t.Fatalf("expected carol@ec.example.com, got %+v", me.User)
	}
}

func TestSAMLSecurityRejections(t *testing.T) {
	rsaKey, certPEM := generateTestRSAIdP(t, "idp.corp.example.com")
	wrongKey, wrongCertPEM := generateTestRSAIdP(t, "attacker.example.org")
	mem := store.NewMemory()
	now := time.Now().UTC().Truncate(time.Second)

	_, ts := newSAMLTestServer(t, mem, func(s *Server) {
		s.Now = func() time.Time { return now }
	})

	ownerClient := newSSOCookieClient(false)
	wsID := registerOwnerAndWS(t, ownerClient, ts.URL)
	wsBase := fmt.Sprintf("%s/api/workspaces/%d/sso", ts.URL, wsID)

	createRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "sec-saml",
		"name":           "Secure SAML",
		"providerType":   "saml",
		"samlEntityId":   "https://idp.corp.example.com/metadata",
		"samlSsoUrl":     "https://idp.corp.example.com/sso",
		"samlIdpCertPem": certPEM,
		"samlSpEntityId": "urn:jiange:sp:sec",
		"autoCreateUser": true,
		"allowedDomains": "corp.example.com",
	})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create sec-saml status=%d", createRes.StatusCode)
	}

	acsURL := ts.URL + "/api/auth/sso/sec-saml/acs"
	newReqID := func() string {
		c := newSSOCookieClient(true)
		r, err := c.Get(ts.URL + "/api/auth/sso/sec-saml/start")
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(r.Header.Get("Location"))
		return u.Query().Get("RelayState")
	}

	assertACSError := func(name string, samlXML []byte, relayState, wantErr string) {
		t.Helper()
		c := newSSOCookieClient(true)
		res := postSAMLACS(t, c, acsURL, samlXML, relayState)
		loc := res.Header.Get("Location")
		if res.StatusCode != http.StatusFound || !strings.Contains(loc, "sso_error="+wantErr) {
			t.Fatalf("%s: status=%d loc=%q, want sso_error=%s", name, res.StatusCode, loc, wantErr)
		}
		// Ensure no authenticated session was issued on rejection.
		meRes, _ := c.Get(ts.URL + "/api/me")
		if meRes.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401 on /api/me after rejection, got %d", name, meRes.StatusCode)
		}
	}

	// 1. Missing signature.
	reqID := newReqID()
	unsigned := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "unsigned@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "unsigned@corp.example.com"},
	})
	assertACSError("missing signature", unsigned, reqID, "saml_signature_invalid")

	// 2. Tampered assertion body after signing (digest mismatch).
	reqID = newReqID()
	baseDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "alice@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "alice@corp.example.com"},
	})
	signedDoc, err := SignSAMLAssertionForTest(certPEM, rsaKey, baseDoc)
	if err != nil {
		t.Fatal(err)
	}
	tamperedBody := bytes.ReplaceAll(signedDoc, []byte("alice@corp.example.com"), []byte("admin@corp.example.com"))
	assertACSError("tampered assertion body", tamperedBody, reqID, "saml_signature_invalid")

	// 3. Tampered SignatureValue bytes.
	reqID = newReqID()
	baseDoc = buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "alice@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "alice@corp.example.com"},
	})
	signedDoc, _ = SignSAMLAssertionForTest(certPEM, rsaKey, baseDoc)
	svStart := bytes.Index(signedDoc, []byte("<ds:SignatureValue>")) + len("<ds:SignatureValue>")
	tamperedSig := append([]byte(nil), signedDoc...)
	if tamperedSig[svStart] == 'A' {
		tamperedSig[svStart] = 'B'
	} else {
		tamperedSig[svStart] = 'A'
	}
	assertACSError("tampered signature bytes", tamperedSig, reqID, "saml_signature_invalid")

	// 4. Signed with wrong IdP certificate / private key.
	reqID = newReqID()
	baseDoc = buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "alice@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "alice@corp.example.com"},
	})
	wrongSigned, err := SignSAMLAssertionForTest(wrongCertPEM, wrongKey, baseDoc)
	if err != nil {
		t.Fatal(err)
	}
	assertACSError("wrong IdP cert", wrongSigned, reqID, "saml_signature_invalid")

	// 5. XML Signature Wrapping (second unsigned Assertion injected into Response).
	reqID = newReqID()
	xswDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo:  reqID,
		Destination:   acsURL,
		Issuer:        "https://idp.corp.example.com/metadata",
		NameID:        "alice@corp.example.com",
		NotBefore:     now.Add(-time.Minute),
		NotOnOrAfter:  now.Add(5 * time.Minute),
		Audience:      "urn:jiange:sp:sec",
		Attributes:    map[string]string{"email": "alice@corp.example.com"},
		ExtraRawChild: `<saml:Assertion ID="evil_assert" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"><saml:Subject><saml:NameID>evil@corp.example.com</saml:NameID></saml:Subject></saml:Assertion>`,
	})
	signedXSW, err := SignSAMLAssertionForTest(certPEM, rsaKey, xswDoc)
	if err != nil {
		t.Fatal(err)
	}
	assertACSError("XSW multi-assertion", signedXSW, reqID, "saml_signature_invalid")

	// 6. DTD / XXE directive rejected.
	xxeXML := []byte(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>`)
	assertACSError("XXE DOCTYPE", xxeXML, reqID, "saml_invalid_response")

	// 7. Non-Success SAML StatusCode rejected.
	reqID = newReqID()
	failedStatusDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		StatusCode:   "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed",
		NameID:       "alice@corp.example.com",
	})
	assertACSError("non-success status", failedStatusDoc, reqID, "saml_status_failed")

	// 8. Expired NotOnOrAfter (beyond 2-minute clock skew).
	reqID = newReqID()
	expiredDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "alice@corp.example.com",
		NotBefore:    now.Add(-20 * time.Minute),
		NotOnOrAfter: now.Add(-5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "alice@corp.example.com"},
	})
	signedExpired, _ := SignSAMLAssertionForTest(certPEM, rsaKey, expiredDoc)
	assertACSError("expired NotOnOrAfter", signedExpired, reqID, "saml_assertion_expired")

	// 9. Wrong Audience when SAMLSpEntityID is configured.
	reqID = newReqID()
	wrongAudDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "alice@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:other-sp:wrong",
		Attributes:   map[string]string{"email": "alice@corp.example.com"},
	})
	signedWrongAud, _ := SignSAMLAssertionForTest(certPEM, rsaKey, wrongAudDoc)
	assertACSError("wrong Audience", signedWrongAud, reqID, "saml_audience_mismatch")

	// 10. Disallowed email domain.
	reqID = newReqID()
	badDomDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "eve@external.example.org",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "eve@external.example.org"},
	})
	signedBadDom, _ := SignSAMLAssertionForTest(certPEM, rsaKey, badDomDoc)
	assertACSError("disallowed email domain", signedBadDom, reqID, "domain_not_allowed")

	// 11. Replay of a valid InResponseTo is rejected on second use.
	reqID = newReqID()
	replayDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: reqID,
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "dave@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "dave@corp.example.com", "displayName": "Dave"},
	})
	signedReplay, _ := SignSAMLAssertionForTest(certPEM, rsaKey, replayDoc)
	firstClient := newSSOCookieClient(true)
	firstRes := postSAMLACS(t, firstClient, acsURL, signedReplay, reqID)
	if firstRes.StatusCode != http.StatusFound || firstRes.Header.Get("Location") != "/#/" {
		t.Fatalf("first use of replayDoc failed: status=%d loc=%q", firstRes.StatusCode, firstRes.Header.Get("Location"))
	}
	assertACSError("replayed InResponseTo", signedReplay, reqID, "invalid_state")

	// 12. Unsolicited / forged InResponseTo rejected (CSRF defense).
	unsolicitedDoc := buildUnsignedSAMLResponseXML(testSAMLResponseOpts{
		InResponseTo: "id_forged_never_issued",
		Destination:  acsURL,
		Issuer:       "https://idp.corp.example.com/metadata",
		NameID:       "mallory@corp.example.com",
		NotBefore:    now.Add(-time.Minute),
		NotOnOrAfter: now.Add(5 * time.Minute),
		Audience:     "urn:jiange:sp:sec",
		Attributes:   map[string]string{"email": "mallory@corp.example.com"},
	})
	signedUnsolicited, _ := SignSAMLAssertionForTest(certPEM, rsaKey, unsolicitedDoc)
	assertACSError("unsolicited InResponseTo", signedUnsolicited, "id_forged_never_issued", "invalid_state")
}
