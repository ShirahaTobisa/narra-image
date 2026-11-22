package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPickAnimatedItems(t *testing.T) {
	moving := map[string]any{"animated": true, "output_format": "gif", "url": "https://upstream.invalid/moving.gif"}
	other := map[string]any{"animated": true, "output_format": "gif", "url": "https://upstream.invalid/other.gif"}
	still := map[string]any{"animated": false, "output_format": "png", "url": "https://upstream.invalid/still.png"}
	formatOnly := map[string]any{"output_format": "gif", "url": "https://upstream.invalid/format-only.gif"}
	unmarked := map[string]any{"b64_json": "R0lGODlh"}

	cases := []struct {
		name  string
		items []map[string]any
		want  []map[string]any
	}{
		{"a single animated item", []map[string]any{moving}, []map[string]any{moving}},
		{"extra still items around it are dropped", []map[string]any{still, moving, still}, []map[string]any{moving}},
		{"marked by format only", []map[string]any{still, formatOnly}, []map[string]any{formatOnly}},
		{"more animated items than asked keeps the first", []map[string]any{moving, other}, []map[string]any{moving}},
		{"unmarked answers are left for the count check", []map[string]any{unmarked, unmarked}, []map[string]any{unmarked, unmarked}},
	}
	for _, testCase := range cases {
		got := pickAnimatedItems(testCase.items, 1)
		if len(got) != len(testCase.want) {
			t.Fatalf("%s: got %d items, want %d", testCase.name, len(got), len(testCase.want))
		}
		for index := range got {
			if got[index]["url"] != testCase.want[index]["url"] || got[index]["b64_json"] != testCase.want[index]["b64_json"] {
				t.Fatalf("%s: item %d = %v, want %v", testCase.name, index, got[index], testCase.want[index])
			}
		}
	}
	if got := mimeTypeFromOutputFormat(GenerationJob{OutputFormat: "gif"}); got != "image/gif" {
		t.Fatalf("gif mime type = %q", got)
	}
}

// A GIF job whose channel answers with a still frame next to the animation: only the animation is
// downloaded, and what the job keeps is the site's own copy, never the channel's link.
func TestGIFJobStoresOnlyTheAnimatedItemAsASiteImage(t *testing.T) {
	gif := append([]byte("GIF89a"), 0xe6, 0x04, 0x73, 0x02, 0, 0, 0, 0x3b) // 1254x627
	var stillRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/images/generations":
			base := "http://" + request.Host
			_ = json.NewEncoder(writer).Encode(map[string]any{"data": []map[string]any{
				{"animated": false, "output_format": "png", "url": base + "/still.png"},
				{"animated": true, "output_format": "gif", "frames": 2, "width": 1254, "height": 627, "url": base + "/moving.gif"},
			}})
		case "/moving.gif":
			writer.Header().Set("Content-Type", "image/gif")
			_, _ = writer.Write(gif)
		default:
			stillRequests.Add(1)
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	records, err := generateImages(
		context.Background(),
		&Storage{cfg: Config{EnableLocalImageFallback: true}},
		GenerationJob{ID: "gif-job", UserID: "user-1", Count: 1, Model: "gpt-image-2.6-sunburst", GenerationType: "TEXT_TO_IMAGE", OutputFormat: "gif", Size: "1024x1024"},
		ProviderConfig{APIKey: "test-key", BaseURL: server.URL, AllowPrivateNetwork: true},
	)
	if err != nil {
		t.Fatalf("generateImages returned error: %v", err)
	}
	if len(records) != 1 || stillRequests.Load() != 0 {
		t.Fatalf("records=%d stillRequests=%d", len(records), stillRequests.Load())
	}
	if strings.Contains(records[0].URL, server.URL) || !strings.HasPrefix(records[0].URL, "data:image/gif;base64,") {
		t.Fatalf("expected the site's own copy of the GIF, got %.60s", records[0].URL)
	}
	if records[0].Width == nil || *records[0].Width != 1254 || records[0].Height == nil || *records[0].Height != 627 {
		t.Fatalf("unexpected dimensions: width=%v height=%v", records[0].Width, records[0].Height)
	}
}
