package store

// notificationPreview uses the current comment body, so editing a comment
// cannot leave an obsolete body visible in later notification responses.
func notificationPreview(body string) string {
	r := []rune(body)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return body
}
