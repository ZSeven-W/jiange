package api

import (
	"bytes"
	"compress/flate"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	nsSAMLMetadata  = "urn:oasis:names:tc:SAML:2.0:metadata"
	nsSAMLProtocol  = "urn:oasis:names:tc:SAML:2.0:protocol"
	nsSAMLAssertion = "urn:oasis:names:tc:SAML:2.0:assertion"
	nsXMLDSig       = "http://www.w3.org/2000/09/xmldsig#"
	nsXMLNS         = "http://www.w3.org/XML/1998/namespace"
	nsExcC14N       = "http://www.w3.org/2001/10/xml-exc-c14n#"
	nsExcC14NComm   = "http://www.w3.org/2001/10/xml-exc-c14n#WithComments"
	nsC14N          = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
	nsC14NComm      = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments"
	nsEnvelopedSig  = "http://www.w3.org/2000/09/xmldsig#enveloped-signature"

	algDigestSHA256 = "http://www.w3.org/2001/04/xmlenc#sha256"
	algDigestSHA1   = "http://www.w3.org/2000/09/xmldsig#sha1"
	algRSASHA256    = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
	algRSASHA1      = "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
	algECDSASHA256  = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"
	algECDSASHA1    = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha1"

	samlBindingHTTPPost = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
	samlStatusSuccess   = "urn:oasis:names:tc:SAML:2.0:status:Success"
	samlClockSkew       = 2 * time.Minute
	samlMaxBodyBytes    = 2 << 20 // 2 MiB
	samlMaxXMLDepth     = 64
)

func samlRequestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if fwdProto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); fwdProto != "" {
		lower := strings.ToLower(fwdProto)
		if lower == "http" || lower == "https" {
			scheme = lower
		}
	}
	host := strings.TrimSpace(r.Host)
	if fwdHost := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); fwdHost != "" && !strings.ContainsAny(fwdHost, "/ \t\r\n") {
		host = fwdHost
	}
	return fmt.Sprintf("%s://%s", scheme, host)
}

func samlMetadataURL(r *http.Request, slug string) string {
	return fmt.Sprintf("%s/api/auth/sso/%s/metadata.xml", samlRequestOrigin(r), url.PathEscape(slug))
}

func samlACSURL(r *http.Request, slug string) string {
	return fmt.Sprintf("%s/api/auth/sso/%s/acs", samlRequestOrigin(r), url.PathEscape(slug))
}

func samlSPEntityID(r *http.Request, prov store.SSOProvider) string {
	if custom := strings.TrimSpace(prov.SAMLSpEntityID); custom != "" {
		return custom
	}
	return samlMetadataURL(r, prov.Slug)
}

func parseSAMLIdPCertificate(pemText string) (*x509.Certificate, error) {
	trimmed := strings.TrimSpace(pemText)
	if trimmed == "" {
		return nil, errors.New("empty certificate PEM")
	}
	block, _ := pem.Decode([]byte(trimmed))
	if block == nil {
		return nil, errors.New("invalid PEM block")
	}
	if block.Type != "CERTIFICATE" && block.Type != "X509 CERTIFICATE" {
		return nil, fmt.Errorf("unexpected PEM block type %q", block.Type)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse x509 certificate: %w", err)
	}
	return cert, nil
}

func randomHex(numBytes int) (string, error) {
	b := make([]byte, numBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func xmlEscapeString(s string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(s))
	return buf.String()
}

// samlMetadata handles GET /api/auth/sso/{slug}/metadata.xml.
func (s *Server) samlMetadata(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	slug := strings.ToLower(strings.TrimSpace(r.PathValue("slug")))
	if slug == "" {
		httpx.Error(w, http.StatusNotFound, "sso_not_found", "未找到该 SAML 登录方式")
		return
	}
	provider, err := st.GetSSOProviderBySlug(r.Context(), slug)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "sso_not_found", "未找到该 SAML 登录方式")
			return
		}
		s.fail(w, r, err)
		return
	}
	if !provider.Enabled || provider.ProviderType != store.SSOProviderSAML {
		httpx.Error(w, http.StatusNotFound, "sso_not_found", "未找到该 SAML 登录方式")
		return
	}

	entityID := samlSPEntityID(r, provider)
	acsURL := samlACSURL(r, provider.Slug)

	var buf bytes.Buffer
	buf.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	fmt.Fprintf(&buf, `<md:EntityDescriptor xmlns:md="%s" entityID="%s">`+"\n",
		nsSAMLMetadata, xmlEscapeString(entityID))
	fmt.Fprintf(&buf, `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="%s">`+"\n",
		nsSAMLProtocol)
	buf.WriteString(`    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` + "\n")
	fmt.Fprintf(&buf, `    <md:AssertionConsumerService Binding="%s" Location="%s" index="0" isDefault="true"/>`+"\n",
		samlBindingHTTPPost, xmlEscapeString(acsURL))
	buf.WriteString(`  </md:SPSSODescriptor>` + "\n")
	buf.WriteString(`</md:EntityDescriptor>` + "\n")

	w.Header().Set("Content-Type", "application/samlmetadata+xml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// startSAML initiates a SAML 2.0 HTTP-Redirect AuthnRequest flow.
func (s *Server) startSAML(w http.ResponseWriter, r *http.Request, prov store.SSOProvider, redirectTo string) {
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	ssoEndpoint, ok := s.validateSSOEndpointURL(prov.SAMLSsoURL, true)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_saml_sso_url", "SAML IdP SSO 地址无效")
		return
	}
	ssoURLParsed, err := url.Parse(ssoEndpoint)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_saml_sso_url", "SAML IdP SSO 地址无效")
		return
	}

	hexID, err := randomHex(16)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	requestID := "id_" + hexID

	if err := st.CreateSSOAuthState(r.Context(), store.SSOAuthState{
		State:        requestID,
		ProviderID:   prov.ID,
		CodeVerifier: "saml",
		Nonce:        requestID,
		RedirectTo:   redirectTo,
		ExpiresAt:    s.now().Add(ssoAuthStateTTL),
	}); err != nil {
		s.fail(w, r, err)
		return
	}

	spEntityID := samlSPEntityID(r, prov)
	acsURL := samlACSURL(r, prov.Slug)
	issueInstant := s.now().UTC().Format("2006-01-02T15:04:05Z")

	var reqXML bytes.Buffer
	fmt.Fprintf(&reqXML,
		`<samlp:AuthnRequest xmlns:samlp="%s" xmlns:saml="%s" ID="%s" Version="2.0" IssueInstant="%s" Destination="%s" AssertionConsumerServiceURL="%s" ProtocolBinding="%s"><saml:Issuer>%s</saml:Issuer></samlp:AuthnRequest>`,
		nsSAMLProtocol,
		nsSAMLAssertion,
		xmlEscapeString(requestID),
		issueInstant,
		xmlEscapeString(ssoEndpoint),
		xmlEscapeString(acsURL),
		samlBindingHTTPPost,
		xmlEscapeString(spEntityID),
	)

	var deflated bytes.Buffer
	fw, err := flate.NewWriter(&deflated, flate.DefaultCompression)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if _, err := fw.Write(reqXML.Bytes()); err != nil {
		_ = fw.Close()
		s.fail(w, r, err)
		return
	}
	if err := fw.Close(); err != nil {
		s.fail(w, r, err)
		return
	}

	encodedReq := base64.StdEncoding.EncodeToString(deflated.Bytes())
	q := ssoURLParsed.Query()
	q.Set("SAMLRequest", encodedReq)
	q.Set("RelayState", requestID)
	ssoURLParsed.RawQuery = q.Encode()

	redirectURL := ssoURLParsed.String()
	if strings.EqualFold(r.URL.Query().Get("mode"), "json") {
		httpx.JSON(w, http.StatusOK, map[string]string{
			"authorizeUrl": redirectURL,
			"state":        requestID,
		})
		return
	}
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// acsSAML handles POST /api/auth/sso/{slug}/acs (SAML 2.0 HTTP-POST Assertion Consumer Service).
func (s *Server) acsSAML(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := s.ssoStore()
	if !ok {
		ssoErrorRedirect(w, r, "sso_unavailable")
		return
	}
	slug := strings.ToLower(strings.TrimSpace(r.PathValue("slug")))
	provider, err := st.GetSSOProviderBySlug(r.Context(), slug)
	if err != nil || !provider.Enabled || provider.ProviderType != store.SSOProviderSAML {
		ssoErrorRedirect(w, r, "provider_disabled")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, samlMaxBodyBytes)
	if err := r.ParseForm(); err != nil {
		ssoErrorRedirect(w, r, "saml_invalid_request")
		return
	}
	rawRespB64 := strings.TrimSpace(r.FormValue("SAMLResponse"))
	relayState := strings.TrimSpace(r.FormValue("RelayState"))
	if rawRespB64 == "" {
		ssoErrorRedirect(w, r, "saml_missing_response")
		return
	}
	xmlBytes, err := decodeBase64Flexible(rawRespB64)
	if err != nil || len(xmlBytes) == 0 || len(xmlBytes) > samlMaxBodyBytes {
		ssoErrorRedirect(w, r, "saml_invalid_response")
		return
	}

	root, err := parseXMLDocument(xmlBytes)
	if err != nil {
		s.Log.Warn("saml response xml parse failed", "provider", provider.Slug, "err", err)
		ssoErrorRedirect(w, r, "saml_invalid_response")
		return
	}
	if root.URI != nsSAMLProtocol || root.Local != "Response" {
		ssoErrorRedirect(w, r, "saml_invalid_response")
		return
	}

	// Verify SAML protocol status is Success.
	statusNode := root.firstChild(nsSAMLProtocol, "Status")
	var statusCode string
	if statusNode != nil {
		if sc := statusNode.firstChild(nsSAMLProtocol, "StatusCode"); sc != nil {
			statusCode = strings.TrimSpace(sc.attrValue("", "Value"))
		}
	}
	if statusCode != samlStatusSuccess {
		ssoErrorRedirect(w, r, "saml_status_failed")
		return
	}

	// Verify Destination when present.
	expectedACS := samlACSURL(r, provider.Slug)
	if dest := strings.TrimSpace(root.attrValue("", "Destination")); dest != "" && dest != expectedACS {
		ssoErrorRedirect(w, r, "saml_destination_mismatch")
		return
	}

	// Parse configured IdP X.509 certificate and cryptographically verify XML-DSig.
	cert, err := parseSAMLIdPCertificate(provider.SAMLIdPCertPEM)
	if err != nil {
		s.Log.Error("saml provider certificate invalid", "provider", provider.Slug, "err", err)
		ssoErrorRedirect(w, r, "invalid_provider_config")
		return
	}
	assertion, err := verifySAMLResponseSignature(root, cert)
	if err != nil {
		s.Log.Warn("saml xml signature verification failed", "provider", provider.Slug, "err", err)
		ssoErrorRedirect(w, r, "saml_signature_invalid")
		return
	}

	// Verify IdP EntityID (Issuer) if configured on the provider.
	if expectedIssuer := strings.TrimSpace(provider.SAMLEntityID); expectedIssuer != "" {
		var gotIssuer string
		if iss := assertion.firstChild(nsSAMLAssertion, "Issuer"); iss != nil {
			gotIssuer = strings.TrimSpace(iss.textContent())
		}
		if gotIssuer == "" {
			if iss := root.firstChild(nsSAMLAssertion, "Issuer"); iss != nil {
				gotIssuer = strings.TrimSpace(iss.textContent())
			}
		}
		if gotIssuer != expectedIssuer {
			ssoErrorRedirect(w, r, "saml_issuer_mismatch")
			return
		}
	}

	// Validate InResponseTo (or RelayState) against single-use SSO auth state to prevent replay & CSRF.
	respInResponseTo := strings.TrimSpace(root.attrValue("", "InResponseTo"))
	var subjInResponseTo, subjRecipient, subjNotOnOrAfter string
	if subj := assertion.firstChild(nsSAMLAssertion, "Subject"); subj != nil {
		for _, sc := range subj.childrenByName(nsSAMLAssertion, "SubjectConfirmation") {
			if scd := sc.firstChild(nsSAMLAssertion, "SubjectConfirmationData"); scd != nil {
				if v := strings.TrimSpace(scd.attrValue("", "InResponseTo")); v != "" && subjInResponseTo == "" {
					subjInResponseTo = v
				}
				if v := strings.TrimSpace(scd.attrValue("", "Recipient")); v != "" && subjRecipient == "" {
					subjRecipient = v
				}
				if v := strings.TrimSpace(scd.attrValue("", "NotOnOrAfter")); v != "" && subjNotOnOrAfter == "" {
					subjNotOnOrAfter = v
				}
			}
		}
	}
	if respInResponseTo != "" && subjInResponseTo != "" && respInResponseTo != subjInResponseTo {
		ssoErrorRedirect(w, r, "invalid_state")
		return
	}
	if subjRecipient != "" && subjRecipient != expectedACS {
		ssoErrorRedirect(w, r, "saml_destination_mismatch")
		return
	}

	stateKey := subjInResponseTo
	if stateKey == "" {
		stateKey = respInResponseTo
	}
	if stateKey == "" {
		stateKey = relayState
	}
	if stateKey == "" {
		ssoErrorRedirect(w, r, "invalid_state")
		return
	}
	authState, err := st.ConsumeSSOAuthState(r.Context(), stateKey, s.now())
	if err != nil || authState.ProviderID != provider.ID {
		ssoErrorRedirect(w, r, "invalid_state")
		return
	}

	// Validate time bounds on SubjectConfirmationData and Conditions, plus AudienceRestriction.
	now := s.now().UTC()
	if subjNotOnOrAfter != "" {
		nooa, err := parseSAMLTime(subjNotOnOrAfter)
		if err != nil || !now.Add(-samlClockSkew).Before(nooa) {
			ssoErrorRedirect(w, r, "saml_assertion_expired")
			return
		}
	}
	if conds := assertion.firstChild(nsSAMLAssertion, "Conditions"); conds != nil {
		if nbStr := strings.TrimSpace(conds.attrValue("", "NotBefore")); nbStr != "" {
			nb, err := parseSAMLTime(nbStr)
			if err != nil || now.Add(samlClockSkew).Before(nb) {
				ssoErrorRedirect(w, r, "saml_assertion_expired")
				return
			}
		}
		if nooaStr := strings.TrimSpace(conds.attrValue("", "NotOnOrAfter")); nooaStr != "" {
			nooa, err := parseSAMLTime(nooaStr)
			if err != nil || !now.Add(-samlClockSkew).Before(nooa) {
				ssoErrorRedirect(w, r, "saml_assertion_expired")
				return
			}
		}
		if expectedAud := strings.TrimSpace(provider.SAMLSpEntityID); expectedAud != "" {
			var audiences []string
			for _, ar := range conds.childrenByName(nsSAMLAssertion, "AudienceRestriction") {
				for _, aud := range ar.childrenByName(nsSAMLAssertion, "Audience") {
					if v := strings.TrimSpace(aud.textContent()); v != "" {
						audiences = append(audiences, v)
					}
				}
			}
			matched := false
			for _, a := range audiences {
				if a == expectedAud {
					matched = true
					break
				}
			}
			if !matched {
				ssoErrorRedirect(w, r, "saml_audience_mismatch")
				return
			}
		}
	}

	// Extract subject (NameID), email, and displayName from verified assertion.
	subject, email, displayName := extractSAMLIdentity(assertion, provider.SAMLAttributeEmail, provider.SAMLAttributeName)
	if subject == "" {
		ssoErrorRedirect(w, r, "identity_missing")
		return
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailMatchesAllowedDomains(email, provider.AllowedDomains) {
		ssoErrorRedirect(w, r, "domain_not_allowed")
		return
	}

	u, err := st.ResolveOrProvisionSSOUser(
		r.Context(),
		provider.ID,
		provider.WorkspaceID,
		subject,
		email,
		displayName,
		provider.AutoCreateUser,
		provider.DefaultRole,
	)
	if err != nil {
		if errors.Is(err, store.ErrForbidden) {
			ssoErrorRedirect(w, r, "user_not_provisioned")
			return
		}
		s.Log.Error("saml user provisioning failed", "provider", provider.Slug, "err", err)
		ssoErrorRedirect(w, r, "login_failed")
		return
	}
	if !s.startSession(w, r, u.ID) {
		return
	}
	s.recordAuthAudit(r, provider.WorkspaceID, u.ID, u.Name, u.Email, "auth.saml_login", map[string]any{
		"providerSlug": provider.Slug,
		"providerType": provider.ProviderType,
	})
	http.Redirect(w, r, sanitizeSSORedirect(authState.RedirectTo), http.StatusFound)
}

func parseSAMLTime(raw string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.UTC(), nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

func extractSAMLIdentity(assertion *xmlNode, emailAttr, nameAttr string) (subject, email, displayName string) {
	if subj := assertion.firstChild(nsSAMLAssertion, "Subject"); subj != nil {
		if nid := subj.firstChild(nsSAMLAssertion, "NameID"); nid != nil {
			subject = strings.TrimSpace(nid.textContent())
		}
	}

	attrs := map[string][]string{}
	attrsLower := map[string][]string{}
	for _, stmt := range assertion.childrenByName(nsSAMLAssertion, "AttributeStatement") {
		for _, attr := range stmt.childrenByName(nsSAMLAssertion, "Attribute") {
			var vals []string
			for _, av := range attr.childrenByName(nsSAMLAssertion, "AttributeValue") {
				if v := strings.TrimSpace(av.textContent()); v != "" {
					vals = append(vals, v)
				}
			}
			if len(vals) == 0 {
				continue
			}
			for _, key := range []string{
				strings.TrimSpace(attr.attrValue("", "Name")),
				strings.TrimSpace(attr.attrValue("", "FriendlyName")),
			} {
				if key == "" {
					continue
				}
				attrs[key] = append(attrs[key], vals...)
				lk := strings.ToLower(key)
				attrsLower[lk] = append(attrsLower[lk], vals...)
			}
		}
	}

	pickAttr := func(candidates ...string) string {
		for _, c := range candidates {
			c = strings.TrimSpace(c)
			if c == "" {
				continue
			}
			if vals := attrs[c]; len(vals) > 0 {
				return vals[0]
			}
			if vals := attrsLower[strings.ToLower(c)]; len(vals) > 0 {
				return vals[0]
			}
		}
		return ""
	}

	email = pickAttr(
		emailAttr,
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
		"http://schemas.xmlsoap.org/claims/EmailAddress",
		"urn:oid:0.9.2342.19200300.100.1.3",
		"email",
		"mail",
		"emailAddress",
	)
	if email == "" && strings.Contains(subject, "@") {
		email = subject
	}

	displayName = pickAttr(
		nameAttr,
		"http://schemas.microsoft.com/identity/claims/displayname",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
		"urn:oid:2.16.840.1.113730.3.1.241",
		"displayName",
		"name",
		"cn",
		"urn:oid:2.5.4.3",
	)
	if displayName == "" {
		given := pickAttr(
			"givenName",
			"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
			"urn:oid:2.5.4.42",
			"firstName",
		)
		sn := pickAttr(
			"sn",
			"surname",
			"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
			"urn:oid:2.5.4.4",
			"lastName",
		)
		displayName = strings.TrimSpace(given + " " + sn)
	}
	return subject, email, displayName
}

func decodeBase64Flexible(s string) ([]byte, error) {
	cleaned := strings.Map(func(r rune) rune {
		if r == ' ' || r == '\t' || r == '\r' || r == '\n' {
			return -1
		}
		return r
	}, s)
	return base64.StdEncoding.DecodeString(cleaned)
}

// --- Pure-Go XML DOM, Exclusive/Inclusive C14N, and XML-DSig Verification ---

type xmlNodeKind uint8

const (
	xmlElementNode xmlNodeKind = iota + 1
	xmlTextNode
	xmlCommentNode
)

type xmlAttr struct {
	Prefix string
	Local  string
	URI    string
	Value  string
}

type xmlNode struct {
	Kind      xmlNodeKind
	Prefix    string
	Local     string
	URI       string
	Text      string
	NSDecls   map[string]string
	InScopeNS map[string]string
	Attrs     []xmlAttr
	Children  []*xmlNode
	Parent    *xmlNode
}

func (n *xmlNode) firstChild(uri, local string) *xmlNode {
	for _, c := range n.Children {
		if c.Kind == xmlElementNode && c.URI == uri && c.Local == local {
			return c
		}
	}
	return nil
}

func (n *xmlNode) childrenByName(uri, local string) []*xmlNode {
	var out []*xmlNode
	for _, c := range n.Children {
		if c.Kind == xmlElementNode && c.URI == uri && c.Local == local {
			out = append(out, c)
		}
	}
	return out
}

func (n *xmlNode) attrValue(uri, local string) string {
	for _, a := range n.Attrs {
		if a.URI == uri && a.Local == local {
			return a.Value
		}
	}
	return ""
}

func (n *xmlNode) textContent() string {
	var b strings.Builder
	var walk func(*xmlNode)
	walk = func(cur *xmlNode) {
		if cur.Kind == xmlTextNode {
			b.WriteString(cur.Text)
			return
		}
		for _, c := range cur.Children {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

func parseXMLDocument(data []byte) (*xmlNode, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true

	var root *xmlNode
	var stack []*xmlNode

	for {
		tok, err := dec.RawToken()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("xml token error: %w", err)
		}
		switch t := tok.(type) {
		case xml.Directive:
			// Reject DOCTYPE / ENTITY declarations (XXE / billion laughs defense).
			return nil, errors.New("xml directives/DTDs are not permitted")
		case xml.ProcInst:
			// Ignore <?xml ...?> declaration and processing instructions.
		case xml.StartElement:
			if len(stack) >= samlMaxXMLDepth {
				return nil, errors.New("xml nesting depth exceeded")
			}
			inScope := map[string]string{"xml": nsXMLNS}
			if len(stack) > 0 {
				for k, v := range stack[len(stack)-1].InScopeNS {
					inScope[k] = v
				}
			}
			nsDecls := map[string]string{}
			rawAttrs := make([]xml.Attr, 0, len(t.Attr))
			seenAttr := map[string]bool{}
			for _, a := range t.Attr {
				key := a.Name.Space + ":" + a.Name.Local
				if seenAttr[key] {
					return nil, fmt.Errorf("duplicate attribute %s", key)
				}
				seenAttr[key] = true
				if a.Name.Space == "" && a.Name.Local == "xmlns" {
					nsDecls[""] = a.Value
					inScope[""] = a.Value
				} else if a.Name.Space == "xmlns" {
					nsDecls[a.Name.Local] = a.Value
					inScope[a.Name.Local] = a.Value
				} else {
					rawAttrs = append(rawAttrs, a)
				}
			}
			elemURI := ""
			if t.Name.Space == "" {
				elemURI = inScope[""]
			} else {
				var ok bool
				elemURI, ok = inScope[t.Name.Space]
				if !ok {
					return nil, fmt.Errorf("undeclared namespace prefix %q", t.Name.Space)
				}
			}
			attrs := make([]xmlAttr, 0, len(rawAttrs))
			for _, a := range rawAttrs {
				attrURI := ""
				if a.Name.Space != "" {
					var ok bool
					attrURI, ok = inScope[a.Name.Space]
					if !ok {
						return nil, fmt.Errorf("undeclared attribute namespace prefix %q", a.Name.Space)
					}
				}
				attrs = append(attrs, xmlAttr{
					Prefix: a.Name.Space,
					Local:  a.Name.Local,
					URI:    attrURI,
					Value:  a.Value,
				})
			}
			node := &xmlNode{
				Kind:      xmlElementNode,
				Prefix:    t.Name.Space,
				Local:     t.Name.Local,
				URI:       elemURI,
				NSDecls:   nsDecls,
				InScopeNS: inScope,
				Attrs:     attrs,
			}
			if len(stack) == 0 {
				if root != nil {
					return nil, errors.New("multiple root elements")
				}
				root = node
			} else {
				parent := stack[len(stack)-1]
				node.Parent = parent
				parent.Children = append(parent.Children, node)
			}
			stack = append(stack, node)
		case xml.EndElement:
			if len(stack) == 0 {
				return nil, errors.New("unexpected closing tag")
			}
			top := stack[len(stack)-1]
			if top.Prefix != t.Name.Space || top.Local != t.Name.Local {
				return nil, fmt.Errorf("mismatched closing tag </%s:%s> for <%s:%s>", t.Name.Space, t.Name.Local, top.Prefix, top.Local)
			}
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) > 0 {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, &xmlNode{
					Kind:   xmlTextNode,
					Text:   string(t),
					Parent: parent,
				})
			} else if strings.TrimSpace(string(t)) != "" {
				return nil, errors.New("unexpected character data outside root")
			}
		case xml.Comment:
			if len(stack) > 0 {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, &xmlNode{
					Kind:   xmlCommentNode,
					Text:   string(t),
					Parent: parent,
				})
			}
		}
	}
	if len(stack) != 0 || root == nil {
		return nil, errors.New("incomplete XML document")
	}
	return root, nil
}

func qname(prefix, local string) string {
	if prefix == "" {
		return local
	}
	return prefix + ":" + local
}

func writeC14NAttrValue(buf *bytes.Buffer, v string) {
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '&':
			buf.WriteString("&amp;")
		case '<':
			buf.WriteString("&lt;")
		case '"':
			buf.WriteString("&quot;")
		case '\t':
			buf.WriteString("&#x9;")
		case '\n':
			buf.WriteString("&#xA;")
		case '\r':
			buf.WriteString("&#xD;")
		default:
			buf.WriteByte(v[i])
		}
	}
}

func writeC14NText(buf *bytes.Buffer, v string) {
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '&':
			buf.WriteString("&amp;")
		case '<':
			buf.WriteString("&lt;")
		case '>':
			buf.WriteString("&gt;")
		case '\r':
			buf.WriteString("&#xD;")
		default:
			buf.WriteByte(v[i])
		}
	}
}

func canonicalizeNode(node, exclude *xmlNode, exclusive, withComments bool, inclusivePrefixes []string) []byte {
	var buf bytes.Buffer
	incSet := make(map[string]bool, len(inclusivePrefixes))
	for _, p := range inclusivePrefixes {
		if p == "#default" {
			incSet[""] = true
		} else if p != "" && p != "xml" {
			incSet[p] = true
		}
	}
	canonicalizeWalk(&buf, node, exclude, exclusive, withComments, incSet, map[string]string{})
	return buf.Bytes()
}

func canonicalizeWalk(buf *bytes.Buffer, node, exclude *xmlNode, exclusive, withComments bool, incSet map[string]bool, renderedNS map[string]string) {
	if node == nil || node == exclude {
		return
	}
	switch node.Kind {
	case xmlTextNode:
		writeC14NText(buf, node.Text)
		return
	case xmlCommentNode:
		if withComments {
			buf.WriteString("<!--")
			buf.WriteString(node.Text)
			buf.WriteString("-->")
		}
		return
	}

	candidates := map[string]bool{}
	if exclusive {
		candidates[node.Prefix] = true
		for _, a := range node.Attrs {
			if a.Prefix != "" && a.Prefix != "xml" {
				candidates[a.Prefix] = true
			}
		}
		for p := range incSet {
			if _, ok := node.InScopeNS[p]; ok || p == "" {
				candidates[p] = true
			}
		}
	} else {
		candidates[""] = true
		for p := range node.InScopeNS {
			if p != "xml" {
				candidates[p] = true
			}
		}
	}
	delete(candidates, "xml")

	nextRendered := make(map[string]string, len(renderedNS)+len(candidates))
	for k, v := range renderedNS {
		nextRendered[k] = v
	}

	type nsPair struct {
		prefix string
		uri    string
	}
	var emitNS []nsPair
	for p := range candidates {
		uri := node.InScopeNS[p]
		prevURI, wasRendered := renderedNS[p]
		if p == "" {
			if !wasRendered {
				if uri != "" {
					emitNS = append(emitNS, nsPair{prefix: "", uri: uri})
					nextRendered[""] = uri
				}
			} else if prevURI != uri {
				emitNS = append(emitNS, nsPair{prefix: "", uri: uri})
				nextRendered[""] = uri
			}
		} else {
			if uri != "" && (!wasRendered || prevURI != uri) {
				emitNS = append(emitNS, nsPair{prefix: p, uri: uri})
				nextRendered[p] = uri
			}
		}
	}
	sort.Slice(emitNS, func(i, j int) bool {
		return emitNS[i].prefix < emitNS[j].prefix
	})

	attrs := append([]xmlAttr(nil), node.Attrs...)
	sort.Slice(attrs, func(i, j int) bool {
		if attrs[i].URI != attrs[j].URI {
			return attrs[i].URI < attrs[j].URI
		}
		return attrs[i].Local < attrs[j].Local
	})

	name := qname(node.Prefix, node.Local)
	buf.WriteByte('<')
	buf.WriteString(name)
	for _, ns := range emitNS {
		if ns.prefix == "" {
			buf.WriteString(` xmlns="`)
		} else {
			buf.WriteString(` xmlns:`)
			buf.WriteString(ns.prefix)
			buf.WriteString(`="`)
		}
		writeC14NAttrValue(buf, ns.uri)
		buf.WriteByte('"')
	}
	for _, a := range attrs {
		buf.WriteByte(' ')
		buf.WriteString(qname(a.Prefix, a.Local))
		buf.WriteString(`="`)
		writeC14NAttrValue(buf, a.Value)
		buf.WriteByte('"')
	}
	buf.WriteByte('>')
	for _, child := range node.Children {
		canonicalizeWalk(buf, child, exclude, exclusive, withComments, incSet, nextRendered)
	}
	buf.WriteString("</")
	buf.WriteString(name)
	buf.WriteByte('>')
}

func findUniqueByID(root *xmlNode, id string) (*xmlNode, error) {
	if id == "" {
		return nil, errors.New("empty reference id")
	}
	var found *xmlNode
	count := 0
	var walk func(*xmlNode)
	walk = func(n *xmlNode) {
		if n.Kind != xmlElementNode {
			return
		}
		for _, a := range n.Attrs {
			if (a.URI == "" && (a.Local == "ID" || a.Local == "Id")) || (a.URI == nsXMLNS && a.Local == "id") {
				if a.Value == id {
					found = n
					count++
					break
				}
			}
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	if count == 0 {
		return nil, fmt.Errorf("referenced ID %q not found", id)
	}
	if count > 1 {
		return nil, fmt.Errorf("duplicate ID %q in SAML document", id)
	}
	return found, nil
}

func countElementsByName(root *xmlNode, uri, local string) int {
	total := 0
	var walk func(*xmlNode)
	walk = func(n *xmlNode) {
		if n.Kind != xmlElementNode {
			return
		}
		if n.URI == uri && n.Local == local {
			total++
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	return total
}

func parseC14NAlgorithm(alg string) (exclusive, withComments bool, ok bool) {
	switch strings.TrimSpace(alg) {
	case nsExcC14N:
		return true, false, true
	case nsExcC14NComm:
		return true, true, true
	case nsC14N:
		return false, false, true
	case nsC14NComm:
		return false, true, true
	default:
		return false, false, false
	}
}

func extractInclusivePrefixes(parent *xmlNode) []string {
	for _, c := range parent.Children {
		if c.Kind == xmlElementNode && c.Local == "InclusiveNamespaces" {
			if pl := strings.TrimSpace(c.attrValue("", "PrefixList")); pl != "" {
				return strings.Fields(pl)
			}
		}
	}
	return nil
}

func computeXMLDigest(alg string, data []byte) ([]byte, error) {
	switch strings.TrimSpace(alg) {
	case algDigestSHA256:
		sum := sha256.Sum256(data)
		return sum[:], nil
	case algDigestSHA1:
		sum := sha1.Sum(data)
		return sum[:], nil
	default:
		return nil, fmt.Errorf("unsupported digest algorithm %q", alg)
	}
}

func verifyXMLSignatureBytes(cert *x509.Certificate, sigAlg string, signedInfoBytes, sigBytes []byte) error {
	switch strings.TrimSpace(sigAlg) {
	case algRSASHA256:
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return errors.New("certificate public key is not RSA")
		}
		sum := sha256.Sum256(signedInfoBytes)
		return rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sigBytes)
	case algRSASHA1:
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return errors.New("certificate public key is not RSA")
		}
		sum := sha1.Sum(signedInfoBytes)
		return rsa.VerifyPKCS1v15(pub, crypto.SHA1, sum[:], sigBytes)
	case algECDSASHA256:
		pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
		if !ok {
			return errors.New("certificate public key is not ECDSA")
		}
		sum := sha256.Sum256(signedInfoBytes)
		return verifyXMLDSigECDSA(pub, sum[:], sigBytes)
	case algECDSASHA1:
		pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
		if !ok {
			return errors.New("certificate public key is not ECDSA")
		}
		sum := sha1.Sum(signedInfoBytes)
		return verifyXMLDSigECDSA(pub, sum[:], sigBytes)
	default:
		return fmt.Errorf("unsupported signature algorithm %q", sigAlg)
	}
}

func verifyXMLDSigECDSA(pub *ecdsa.PublicKey, digest, sigBytes []byte) error {
	coordSize := (pub.Curve.Params().BitSize + 7) / 8
	if len(sigBytes) == 2*coordSize {
		r := new(big.Int).SetBytes(sigBytes[:coordSize])
		s := new(big.Int).SetBytes(sigBytes[coordSize:])
		if ecdsa.Verify(pub, digest, r, s) {
			return nil
		}
		return errors.New("ecdsa signature verification failed")
	}
	if ecdsa.VerifyASN1(pub, digest, sigBytes) {
		return nil
	}
	return errors.New("ecdsa signature verification failed")
}

func verifyEnvelopedSignature(root, sigNode, expectedTarget *xmlNode, cert *x509.Certificate) error {
	signedInfo := sigNode.firstChild(nsXMLDSig, "SignedInfo")
	if signedInfo == nil {
		return errors.New("missing SignedInfo")
	}
	sigValNode := sigNode.firstChild(nsXMLDSig, "SignatureValue")
	if sigValNode == nil {
		return errors.New("missing SignatureValue")
	}
	c14nMethod := signedInfo.firstChild(nsXMLDSig, "CanonicalizationMethod")
	if c14nMethod == nil {
		return errors.New("missing CanonicalizationMethod")
	}
	c14nExcl, c14nComm, ok := parseC14NAlgorithm(c14nMethod.attrValue("", "Algorithm"))
	if !ok {
		return fmt.Errorf("unsupported CanonicalizationMethod %q", c14nMethod.attrValue("", "Algorithm"))
	}
	sigInfoIncPrefixes := extractInclusivePrefixes(c14nMethod)

	sigMethod := signedInfo.firstChild(nsXMLDSig, "SignatureMethod")
	if sigMethod == nil {
		return errors.New("missing SignatureMethod")
	}
	sigAlg := strings.TrimSpace(sigMethod.attrValue("", "Algorithm"))

	refs := signedInfo.childrenByName(nsXMLDSig, "Reference")
	if len(refs) == 0 {
		return errors.New("SignedInfo has no Reference")
	}

	coveredExpected := false
	for _, ref := range refs {
		uri := strings.TrimSpace(ref.attrValue("", "URI"))
		var target *xmlNode
		var err error
		if uri == "" {
			target = root
		} else if strings.HasPrefix(uri, "#") {
			target, err = findUniqueByID(root, uri[1:])
			if err != nil {
				return err
			}
		} else {
			return fmt.Errorf("unsupported Reference URI %q", uri)
		}

		// Parse transforms.
		enveloped := false
		refExcl := false
		refComm := false
		var refIncPrefixes []string
		if transforms := ref.firstChild(nsXMLDSig, "Transforms"); transforms != nil {
			for _, tr := range transforms.childrenByName(nsXMLDSig, "Transform") {
				alg := strings.TrimSpace(tr.attrValue("", "Algorithm"))
				if alg == nsEnvelopedSig {
					enveloped = true
					continue
				}
				if ex, cm, valid := parseC14NAlgorithm(alg); valid {
					refExcl = ex
					refComm = cm
					refIncPrefixes = extractInclusivePrefixes(tr)
					continue
				}
				return fmt.Errorf("unsupported Transform algorithm %q", alg)
			}
		}

		var exclude *xmlNode
		if enveloped {
			exclude = sigNode
		}
		canonTarget := canonicalizeNode(target, exclude, refExcl, refComm, refIncPrefixes)

		digestMethod := ref.firstChild(nsXMLDSig, "DigestMethod")
		digestValNode := ref.firstChild(nsXMLDSig, "DigestValue")
		if digestMethod == nil || digestValNode == nil {
			return errors.New("Reference missing DigestMethod or DigestValue")
		}
		computedDigest, err := computeXMLDigest(digestMethod.attrValue("", "Algorithm"), canonTarget)
		if err != nil {
			return err
		}
		expectedDigest, err := decodeBase64Flexible(digestValNode.textContent())
		if err != nil {
			return fmt.Errorf("invalid DigestValue base64: %w", err)
		}
		if subtle.ConstantTimeCompare(computedDigest, expectedDigest) != 1 {
			return errors.New("XML digest mismatch")
		}
		if target == expectedTarget {
			coveredExpected = true
		}
	}

	if !coveredExpected {
		return errors.New("signature does not cover expected SAML element")
	}

	canonSignedInfo := canonicalizeNode(signedInfo, nil, c14nExcl, c14nComm, sigInfoIncPrefixes)
	sigBytes, err := decodeBase64Flexible(sigValNode.textContent())
	if err != nil {
		return fmt.Errorf("invalid SignatureValue base64: %w", err)
	}
	return verifyXMLSignatureBytes(cert, sigAlg, canonSignedInfo, sigBytes)
}

// verifySAMLResponseSignature cryptographically verifies the XML-DSig signature on the
// SAML Assertion and/or enclosing SAML Response, defending against XML Signature Wrapping.
func verifySAMLResponseSignature(root *xmlNode, cert *x509.Certificate) (*xmlNode, error) {
	// Guard against XSW multi-assertion smuggling anywhere in the document.
	if countElementsByName(root, nsSAMLAssertion, "Assertion") != 1 {
		return nil, errors.New("SAML response must contain exactly one Assertion")
	}
	assertions := root.childrenByName(nsSAMLAssertion, "Assertion")
	if len(assertions) != 1 {
		return nil, errors.New("Assertion must be a direct child of Response")
	}
	assertion := assertions[0]

	assertionSig := assertion.firstChild(nsXMLDSig, "Signature")
	responseSig := root.firstChild(nsXMLDSig, "Signature")
	if assertionSig == nil && responseSig == nil {
		return nil, errors.New("missing XML signature on SAML Response/Assertion")
	}
	if assertionSig != nil {
		if err := verifyEnvelopedSignature(root, assertionSig, assertion, cert); err != nil {
			return nil, fmt.Errorf("assertion signature invalid: %w", err)
		}
	}
	if responseSig != nil {
		if err := verifyEnvelopedSignature(root, responseSig, root, cert); err != nil {
			return nil, fmt.Errorf("response signature invalid: %w", err)
		}
	}
	return assertion, nil
}

// SignSAMLAssertionForTest produces a genuinely XML-DSig signed SAML 2.0 XML document
// using enveloped Exclusive C14N and SHA-256 (RSA-SHA256 or ECDSA-SHA256) on the Assertion.
func SignSAMLAssertionForTest(certPEM string, privKey crypto.Signer, xmlDoc []byte) ([]byte, error) {
	return signSAMLElement(certPEM, privKey, xmlDoc, "Assertion", "", algDigestSHA256)
}

func signSAMLElement(certPEM string, privKey crypto.Signer, xmlDoc []byte, targetLocal, sigAlgOverride, digestAlg string) ([]byte, error) {
	cert, err := parseSAMLIdPCertificate(certPEM)
	if err != nil {
		return nil, err
	}
	root, err := parseXMLDocument(xmlDoc)
	if err != nil {
		return nil, err
	}

	var target *xmlNode
	switch targetLocal {
	case "Response":
		if root.URI != nsSAMLProtocol || root.Local != "Response" {
			return nil, errors.New("root element is not samlp:Response")
		}
		target = root
	default:
		if root.URI == nsSAMLAssertion && root.Local == "Assertion" {
			target = root
		} else {
			target = root.firstChild(nsSAMLAssertion, "Assertion")
		}
		if target == nil {
			return nil, errors.New("no saml:Assertion element found to sign")
		}
	}

	targetID := strings.TrimSpace(target.attrValue("", "ID"))
	if targetID == "" {
		return nil, errors.New("target element missing ID attribute")
	}

	if digestAlg == "" {
		digestAlg = algDigestSHA256
	}
	sigAlg := sigAlgOverride
	if sigAlg == "" {
		switch privKey.(type) {
		case *rsa.PrivateKey:
			sigAlg = algRSASHA256
		case *ecdsa.PrivateKey:
			sigAlg = algECDSASHA256
		default:
			return nil, fmt.Errorf("unsupported private key type %T", privKey)
		}
	}

	canonTarget := canonicalizeNode(target, nil, true, false, nil)
	digestBytes, err := computeXMLDigest(digestAlg, canonTarget)
	if err != nil {
		return nil, err
	}
	digestB64 := base64.StdEncoding.EncodeToString(digestBytes)

	signedInfoXML := fmt.Sprintf(
		`<ds:SignedInfo xmlns:ds="%s"><ds:CanonicalizationMethod Algorithm="%s"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="%s"></ds:SignatureMethod><ds:Reference URI="#%s"><ds:Transforms><ds:Transform Algorithm="%s"></ds:Transform><ds:Transform Algorithm="%s"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="%s"></ds:DigestMethod><ds:DigestValue>%s</ds:DigestValue></ds:Reference></ds:SignedInfo>`,
		nsXMLDSig,
		nsExcC14N,
		sigAlg,
		xmlEscapeString(targetID),
		nsEnvelopedSig,
		nsExcC14N,
		digestAlg,
		digestB64,
	)
	signedInfoNode, err := parseXMLDocument([]byte(signedInfoXML))
	if err != nil {
		return nil, err
	}
	canonSignedInfo := canonicalizeNode(signedInfoNode, nil, true, false, nil)

	var sigBytes []byte
	switch sigAlg {
	case algRSASHA256:
		rsaKey, ok := privKey.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("rsa-sha256 requires *rsa.PrivateKey")
		}
		sum := sha256.Sum256(canonSignedInfo)
		sigBytes, err = rsa.SignPKCS1v15(rand.Reader, rsaKey, crypto.SHA256, sum[:])
	case algRSASHA1:
		rsaKey, ok := privKey.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("rsa-sha1 requires *rsa.PrivateKey")
		}
		sum := sha1.Sum(canonSignedInfo)
		sigBytes, err = rsa.SignPKCS1v15(rand.Reader, rsaKey, crypto.SHA1, sum[:])
	case algECDSASHA256:
		ecKey, ok := privKey.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("ecdsa-sha256 requires *ecdsa.PrivateKey")
		}
		sum := sha256.Sum256(canonSignedInfo)
		rVal, sVal, signErr := ecdsa.Sign(rand.Reader, ecKey, sum[:])
		if signErr != nil {
			return nil, signErr
		}
		coordSize := (ecKey.Curve.Params().BitSize + 7) / 8
		sigBytes = make([]byte, 2*coordSize)
		rVal.FillBytes(sigBytes[:coordSize])
		sVal.FillBytes(sigBytes[coordSize:])
	default:
		return nil, fmt.Errorf("unsupported test signing algorithm %q", sigAlg)
	}
	if err != nil {
		return nil, err
	}

	sigB64 := base64.StdEncoding.EncodeToString(sigBytes)
	certB64 := base64.StdEncoding.EncodeToString(cert.Raw)
	sigXML := fmt.Sprintf(
		`<ds:Signature xmlns:ds="%s">%s<ds:SignatureValue>%s</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>%s</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>`,
		nsXMLDSig,
		signedInfoXML,
		sigB64,
		certB64,
	)
	sigNode, err := parseXMLDocument([]byte(sigXML))
	if err != nil {
		return nil, err
	}

	// Insert <ds:Signature> directly after <saml:Issuer> inside target (standard SAML schema order).
	insertIdx := 0
	for i, c := range target.Children {
		if c.Kind == xmlElementNode && c.URI == nsSAMLAssertion && c.Local == "Issuer" {
			insertIdx = i + 1
			break
		}
	}
	sigNode.Parent = target
	target.Children = append(target.Children, nil)
	copy(target.Children[insertIdx+1:], target.Children[insertIdx:])
	target.Children[insertIdx] = sigNode

	return canonicalizeNode(root, nil, true, false, nil), nil
}
