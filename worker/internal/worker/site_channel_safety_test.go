package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func expectedSafetyIdentifier(userID string) string {
	sum := sha256.Sum256([]byte("narra-user:" + userID))
	return hex.EncodeToString(sum[:])
}

// 站内渠道：带 safety_identifier，且不转发用户选的宽松审核档；自填渠道：保持用户原样。
func TestImageGenerationSafetyFieldsBySiteChannel(t *testing.T) {
	cases := []struct {
		name               string
		providerMode       string
		wantIdentifier     bool
		wantModerationSent string
	}{
		{name: "site channel", providerMode: "BUILT_IN", wantIdentifier: true, wantModerationSent: ""},
		{name: "custom channel", providerMode: "CUSTOM", wantIdentifier: false, wantModerationSent: "low"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatalf("decode request body: %v", err)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"b64_json": "Y2F0"}}})
			}))
			defer server.Close()

			_, err := generateWithImageGeneration(context.Background(), GenerationJob{
				Count:        1,
				ID:           "job_safety_1",
				Model:        "gpt-image-2",
				Moderation:   "low",
				Prompt:       "a cat",
				ProviderMode: tc.providerMode,
				Size:         "auto",
				UserID:       "user_1",
			}, ProviderConfig{APIKey: "test-key", BaseURL: server.URL, AllowPrivateNetwork: true})
			if err != nil {
				t.Fatalf("generateWithImageGeneration returned error: %v", err)
			}

			identifier, hasIdentifier := body["safety_identifier"]
			if hasIdentifier != tc.wantIdentifier {
				t.Fatalf("safety_identifier present = %v, want %v", hasIdentifier, tc.wantIdentifier)
			}
			if tc.wantIdentifier && identifier != expectedSafetyIdentifier("user_1") {
				t.Fatalf("unexpected safety_identifier %v", identifier)
			}
			moderation, _ := body["moderation"].(string)
			if moderation != tc.wantModerationSent {
				t.Fatalf("moderation sent = %q, want %q", moderation, tc.wantModerationSent)
			}
		})
	}
}

func TestImageEditSendsSafetyIdentifierForSiteChannel(t *testing.T) {
	var identifier string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reader, err := r.MultipartReader()
		if err != nil {
			t.Fatalf("read multipart request: %v", err)
		}
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("read multipart part: %v", err)
			}
			if part.FormName() == "safety_identifier" {
				value, _ := io.ReadAll(part)
				identifier = string(value)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"b64_json": "Y2F0"}}})
	}))
	defer server.Close()

	_, err := generateWithImageEdit(context.Background(), GenerationJob{
		ID:           "job_safety_edit",
		Model:        "gpt-image-2",
		Prompt:       "make it blue",
		ProviderMode: "BUILT_IN",
		Size:         "auto",
		UserID:       "user_2",
	}, ProviderConfig{APIKey: "test-key", BaseURL: server.URL, AllowPrivateNetwork: true}, []SourceImage{
		{Data: []byte("png-bytes"), FileName: "source.png", MimeType: "image/png"},
	})
	if err != nil {
		t.Fatalf("generateWithImageEdit returned error: %v", err)
	}
	if identifier != expectedSafetyIdentifier("user_2") {
		t.Fatalf("unexpected safety_identifier %q", identifier)
	}
}

func TestResponsesRequestSafetyFieldsBySiteChannel(t *testing.T) {
	site := buildResponsesRequest(GenerationJob{
		Model: "gpt-image-2", Moderation: "low", Prompt: "a cat", ProviderMode: "BUILT_IN", UserID: "user_3",
	}, "https://api.openai.com/v1", nil, false)
	if site["safety_identifier"] != expectedSafetyIdentifier("user_3") {
		t.Fatalf("site channel safety_identifier = %v", site["safety_identifier"])
	}
	if tool := site["tools"].([]any)[0].(map[string]any); tool["moderation"] != nil {
		t.Fatalf("site channel should not forward moderation, got %v", tool["moderation"])
	}

	custom := buildResponsesRequest(GenerationJob{
		Model: "gpt-image-2", Moderation: "low", Prompt: "a cat", ProviderMode: "CUSTOM", UserID: "user_3",
	}, "https://example.com/v1", nil, false)
	if _, ok := custom["safety_identifier"]; ok {
		t.Fatal("custom channel should not get safety_identifier")
	}
	if tool := custom["tools"].([]any)[0].(map[string]any); tool["moderation"] != "low" {
		t.Fatalf("custom channel moderation = %v, want low", tool["moderation"])
	}
}
