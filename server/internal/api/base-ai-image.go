package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const maxAIImageBytes = 10 << 20

type aiInputImage struct {
	MIME string
	Data []byte
}

// aiVisionRequest uses inline image bytes, never a URL supplied by a client.
func aiVisionRequest(ctx context.Context, base, key, model, provider string, messages []aiMessage, image aiInputImage) (*http.Request, error) {
	encoded := base64.StdEncoding.EncodeToString(image.Data)
	var payload map[string]any
	path := "/chat/completions"
	if provider == "anthropic" {
		path = "/messages"
		payload = map[string]any{"model": model, "max_tokens": 2048, "temperature": 0.3, "system": messages[0].Content, "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": image.MIME, "data": encoded}}, map[string]any{"type": "text", "text": messages[1].Content}}}}}
	} else {
		payload = map[string]any{"model": model, "max_tokens": 2048, "temperature": 0.3, "messages": []any{messages[0], map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": messages[1].Content}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + image.MIME + ";base64," + encoded}}}}}}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if provider == "anthropic" {
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", aiAnthropicVersion)
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return req, nil
}

// baseAIImageImportPreview accepts one bounded JPEG or PNG and two prompt
// messages. It never persists the image and requires the same account, edit,
// copy and restricted-view checks as text recognition.
func (s *Server) baseAIImageImportPreview(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok || !expectedImportAccount(w, r, u.ID, true) {
		return
	}
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok || !s.allowBaseWrite(w, r, b) {
		return
	}
	if !store.DocumentCopyAllowed(b, b.Role) {
		httpx.Error(w, http.StatusForbidden, "copy_restricted", "该文档禁止复制内容，不能发送给 AI")
		return
	}
	release, ok := acquireCoverDecode(w)
	if !ok {
		return
	}
	defer release()
	r.Body = http.MaxBytesReader(w, r.Body, maxAIImageBytes+(256<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_upload", "请选择图片")
		return
	}
	var imageData, messageData []byte
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_upload", "图片上传失败或超过大小限制")
			return
		}
		switch part.FormName() {
		case "image":
			if imageData != nil {
				part.Close()
				httpx.Error(w, http.StatusBadRequest, "invalid_upload", "只能上传一张图片")
				return
			}
			imageData, err = io.ReadAll(io.LimitReader(part, maxAIImageBytes+1))
		case "messages":
			if messageData != nil {
				part.Close()
				httpx.Error(w, http.StatusBadRequest, "invalid_upload", "消息重复")
				return
			}
			messageData, err = io.ReadAll(io.LimitReader(part, 100_001))
		default:
			part.Close()
			httpx.Error(w, http.StatusBadRequest, "invalid_upload", "不支持的上传内容")
			return
		}
		part.Close()
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_upload", "图片上传失败或超过大小限制")
			return
		}
	}
	if len(imageData) == 0 || len(imageData) > maxAIImageBytes || len(messageData) == 0 || len(messageData) > 100_000 {
		httpx.Error(w, http.StatusBadRequest, "invalid_upload", "图片需为 10 MiB 以内的 JPG 或 PNG")
		return
	}
	mime := http.DetectContentType(imageData)
	if (mime != "image/jpeg" && mime != "image/png") || validateCoverImage(imageData, mime) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_image", "图片无效或尺寸过大，请使用 JPG 或 PNG")
		return
	}
	var messages []aiMessage
	if json.Unmarshal(messageData, &messages) != nil || len(messages) != 2 || messages[0].Role != "system" || messages[1].Role != "user" || utf8.RuneCountInString(messages[0].Content)+utf8.RuneCountInString(messages[1].Content) > aiMaxInputChars {
		httpx.Error(w, http.StatusBadRequest, "invalid_messages", "识别内容无效或过长")
		return
	}
	if !s.aiRate.allow(u.ID, s.now()) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_rate_limited", "请求过于频繁，请稍后再试")
		return
	}
	result, err := s.callAIWithImage(r.Context(), u.ID, messages, &aiInputImage{MIME: mime, Data: imageData})
	if err != nil {
		s.aiError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]string{"text": result})
}
