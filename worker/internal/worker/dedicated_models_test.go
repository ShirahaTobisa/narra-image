package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDedicatedModelRoutingAndLimits(t *testing.T) {
	for _, model := range []string{seedreamModel, h3Model} {
		if providerSupportsModel("gpt-image-2", model, []string{"*"}) {
			t.Fatalf("wildcard accepted %s", model)
		}
		if upstreamModel("gpt-image-2", model, []string{"*"}) != model {
			t.Fatalf("wildcard rewrote %s", model)
		}
		if upstreamModel("gpt-image-2", " "+model+" ", []string{"*"}) != model || providerSupportsModel("gpt-image-2", " "+model+" ", []string{"*"}) {
			t.Fatalf("whitespace enabled a wildcard override for %s", model)
		}
		if !providerSupportsModel(model, model, nil) || !providerSupportsModel("gpt-image-2", model, []string{model, "*"}) {
			t.Fatalf("explicit configuration rejected %s", model)
		}
	}
	for _, test := range []struct {
		model, base string
		valid       bool
	}{
		{seedreamModel, "https://api.apimart.ai/v1", true},
		{h3Model, "https://h3.coolhs.com/api/v1/", true},
		{h3Model, "https://h3.coolhs.com/v1", true},
		{seedreamModel, "https://api.apimart.ai.evil.test/v1", false},
		{h3Model, "http://h3.coolhs.com/api/v1", false},
		{h3Model, "https://h3.coolhs.com:444/api/v1", false},
		{h3Model, "https://key@h3.coolhs.com/api/v1", false},
		{h3Model, "https://h3.coolhs.com/api/v1?target=other", false},
		{h3Model, "https://h3.coolhs.com/api/v1/../proxy", false},
		{h3Model, "https://h3.coolhs.com/api/%761", false},
		{seedreamModel, "https://h3.coolhs.com/v1", false},
	} {
		err := validateDedicatedProvider(test.model, ProviderConfig{Model: test.model, BaseURL: test.base})
		if (err == nil) != test.valid {
			t.Errorf("%s %s: %v", test.model, test.base, err)
		}
	}
	if err := validateDedicatedProvider(h3Model, ProviderConfig{Model: "gpt-image-2", BaseURL: "https://h3.coolhs.com/v1"}); err == nil {
		t.Fatal("model override accepted")
	}
	base := GenerationJob{Model: h3Model, Count: 1, GenerationType: "TEXT_TO_VIDEO", Size: "1280x736", DurationSeconds: sql.NullInt32{Int32: 6, Valid: true}}
	if err := validateDedicatedJob(base); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*GenerationJob){
		func(j *GenerationJob) { j.Count = 2 },
		func(j *GenerationJob) { j.DurationSeconds.Int32 = 10 },
		func(j *GenerationJob) { j.Size = "1920x1080" },
		func(j *GenerationJob) { j.GenerationType = "IMAGE_TO_VIDEO" },
		func(j *GenerationJob) { j.SourceImageURLs = []string{"a", "b"} },
		func(j *GenerationJob) { j.GenerationType = "TEXT_TO_IMAGE" },
	} {
		job := base
		mutate(&job)
		if err := validateDedicatedJob(job); err == nil {
			t.Errorf("invalid H3 job accepted: %+v", job)
		}
	}
	seed := GenerationJob{Model: seedreamModel, Count: 1, GenerationType: "TEXT_TO_IMAGE", Size: "1824x1024", OutputFormat: "png"}
	if err := validateDedicatedJob(seed); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*GenerationJob){
		func(j *GenerationJob) { j.Count = 4 },
		func(j *GenerationJob) { j.OutputFormat = "webp" },
		func(j *GenerationJob) { j.SourceImageURLs = []string{"a", "b"} },
		func(j *GenerationJob) { j.GenerationType = "TEXT_TO_VIDEO" },
	} {
		job := seed
		mutate(&job)
		if err := validateDedicatedJob(job); err == nil {
			t.Errorf("invalid Seedream job accepted: %+v", job)
		}
	}
}

func dedicatedTestClient(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: canvasTestRoundTripper(func(request *http.Request) (*http.Response, error) {
		writer := httptest.NewRecorder()
		handler(writer, request)
		return writer.Result(), nil
	})}
	t.Cleanup(func() { http.DefaultClient = previous })
}

func TestSeedreamSubmitPollAndFixedTier(t *testing.T) {
	for _, size := range []string{"auto", "1824x1024", "3840x2160"} {
		t.Run(size, func(t *testing.T) {
			polls := 0
			dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Host != "api.apimart.ai" || r.Header.Get("Authorization") != "Bearer test-key" {
					t.Fatalf("wrong provider request: %s", r.URL)
				}
				switch r.URL.Path {
				case "/v1/images/generations":
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if body["n"] != float64(1) || body["nsfw_check"] != false || body["model"] != seedreamModel {
						t.Fatalf("bad submit: %#v", body)
					}
					if size == "auto" {
						if body["size"] != "1K" {
							t.Fatalf("default resolution leaked: %#v", body)
						}
					} else if body["size"] != "16:9" || body["resolution"] != "1K" {
						t.Fatalf("pixel tier leaked: %#v", body)
					}
					if refs, ok := body["image_urls"].([]any); !ok || len(refs) != 1 || !strings.HasPrefix(refs[0].(string), "data:image/png;base64,") {
						t.Fatalf("bad reference: %#v", body)
					}
					if r.Header.Get("Idempotency-Key") != "narra-image:seed-job:images-generations" {
						t.Fatal("missing stable key")
					}
					fmt.Fprint(w, `{"data":[{"task_id":"task_1"}]}`)
				case "/v1/tasks/task_1":
					polls++
					if polls == 1 {
						fmt.Fprint(w, `{"data":{"status":"processing"}}`)
					} else {
						fmt.Fprint(w, `{"data":{"status":"completed","result":{"images":[{"url":["https://result.test/image.png"],"sizes":["1280x720"]}]}}}`)
					}
				default:
					t.Fatalf("unexpected request: %s", r.URL)
				}
			})
			requestID := ""
			ctx := withProviderLifecycle(context.Background(), nil, nil, func(_ context.Context, id string) error { requestID = id; return nil })
			payload, err := generateSeedream(ctx, GenerationJob{ID: "seed-job", Model: seedreamModel, Count: 1, Size: size}, ProviderConfig{APIKey: "test-key", Model: seedreamModel, BaseURL: "https://api.apimart.ai/v1", AllowPrivateNetwork: true}, []SourceImage{{Data: imageHistoryPNG(t), MimeType: "image/png"}}, time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			if requestID != "task_1" || polls != 2 || len(payload.Data) != 1 || payload.Data[0]["url"] != "https://result.test/image.png" || payload.Data[0]["size"] != "1280x720" {
				t.Fatalf("bad result: %s %+v", requestID, payload)
			}
		})
	}
}

func TestH3NativeUploadLifecycleAndExternalResult(t *testing.T) {
	for _, baseURL := range []string{"https://h3.coolhs.com/v1", "https://h3.coolhs.com/api/v1", "https://H3.COOLHS.COM:443/v1//"} {
		t.Run(baseURL, func(t *testing.T) {
			submitting, submitted, polls := 0, 0, 0
			requestID := ""
			dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Host != "h3.coolhs.com" || r.Header.Get("Authorization") != "Bearer card" {
					t.Fatalf("wrong request: %s", r.URL)
				}
				switch r.URL.Path {
				case "/api/v1/uploads":
					if submitting != 0 || submitted != 0 {
						t.Fatal("upload marked paid task submitted")
					}
					reader, err := r.MultipartReader()
					if err != nil {
						t.Fatal(err)
					}
					part, err := reader.NextPart()
					if err != nil {
						t.Fatal(err)
					}
					data, _ := io.ReadAll(part)
					if part.FormName() != "files" || string(data) != string(imageHistoryPNG(t)) {
						t.Fatal("source bytes changed")
					}
					fmt.Fprint(w, `{"items":[{"ref":"source.png"}]}`)
				case "/api/v1/jobs":
					if submitting != 1 || submitted != 0 {
						t.Fatal("wrong submit lifecycle")
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if body["preset"] != "reference" || body["width"] != float64(1280) || body["height"] != float64(736) || body["seconds"] != float64(6) || body["images"].([]any)[0] != "source.png" {
						t.Fatalf("bad native payload: %#v", body)
					}
					if r.Header.Get("Idempotency-Key") != "narra-image:h3-job:h3-jobs" {
						t.Fatal("missing stable key")
					}
					fmt.Fprint(w, `{"job":{"id":42,"status":"pending"}}`)
				case "/api/v1/jobs/42":
					polls++
					fmt.Fprint(w, `{"job":{"id":42,"status":"done","has_video":true,"has_poster":true,"width":1344,"height":768,"seconds":6}}`)
				default:
					t.Fatalf("must not download media or use compatible API: %s", r.URL)
				}
			})
			ctx := withProviderLifecycle(context.Background(), func(context.Context) error { submitting++; return nil }, func(context.Context, string) error { submitted++; return nil }, func(_ context.Context, id string) error { requestID = id; return nil })
			job := GenerationJob{ID: "h3-job", Model: h3Model, Count: 1, GenerationType: "IMAGE_TO_VIDEO", Prompt: "waves", Size: "1280x736", DurationSeconds: sql.NullInt32{Int32: 6, Valid: true}, SourceImageURLs: []string{imageDataURL(SourceImage{Data: imageHistoryPNG(t), MimeType: "image/png"})}}
			result, err := generateVideo(ctx, nil, job, ProviderConfig{Model: h3Model, BaseURL: baseURL, APIKey: "card", AllowPrivateNetwork: true}, time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			if submitting != 1 || submitted != 1 || requestID != "42" || polls != 1 {
				t.Fatalf("bad lifecycle: %d %d %s %d", submitting, submitted, requestID, polls)
			}
			if result.MediaStorage != MediaStorageUpstream || result.StorageKey != "" || result.URL != "https://h3.coolhs.com/api/v1/jobs/42/video" || result.PosterURL != "https://h3.coolhs.com/api/v1/jobs/42/poster" || *result.Width != 1344 || *result.Height != 768 || *result.DurationSeconds != 6 {
				t.Fatalf("bad external result: %+v", result)
			}
		})
	}
}

func TestDedicatedFailuresDoNotMislabelOrRefundUnknownTasks(t *testing.T) {
	for _, test := range []struct {
		name, body, code  string
		status            int
		unknown, resolved bool
	}{
		{"failed", `{"data":{"status":"failed","error":{"reason":"service_unavailable","message":"private vendor details"}}}`, errorProviderGenerationFailed, 200, false, true},
		{"policy", `{"data":{"status":"failed","error":{"reason":"content_policy_violation"}}}`, errorProviderPolicyRejected, 200, false, true},
		{"lookup failed", `{"error":"unavailable"}`, errorHandoffUnknown, 503, true, false},
		{"lookup policy error", `{"error":{"code":"content_policy_violation"}}`, errorHandoffUnknown, 403, true, false},
		{"malformed", `{`, errorResultPersistFailed, 200, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					fmt.Fprint(w, `{"data":[{"task_id":"t1"}]}`)
					return
				}
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			})
			_, err := generateSeedream(context.Background(), GenerationJob{ID: "j", Count: 1}, ProviderConfig{Model: seedreamModel, BaseURL: "https://api.apimart.ai/v1", AllowPrivateNetwork: true}, nil, time.Millisecond)
			failure := classifyProviderFailure(err)
			if failure.Code != test.code || failure.HandoffUnknown != test.unknown || failure.ResolvedAfterSubmit != test.resolved || strings.Contains(failure.Message, "private") {
				t.Fatalf("wrong failure: %+v", failure)
			}
		})
	}
}

func TestSeedreamGenerationPersistsViaExistingImageStorage(t *testing.T) {
	image := imageHistoryPNG(t)
	dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			fmt.Fprint(w, `{"data":[{"task_id":"image-task"}]}`)
		case "/v1/tasks/image-task":
			fmt.Fprint(w, `{"data":{"status":"completed","result":{"images":[{"url":["https://result.test/image.png"]}]}}}`)
		case "/image.png":
			if r.Header.Get("Authorization") != "" {
				t.Fatal("image download leaked vendor credentials")
			}
			w.Header().Set("Content-Type", "image/png")
			w.Write(image)
		default:
			t.Fatalf("Seedream reached an unrelated endpoint: %s", r.URL)
		}
	})
	job := GenerationJob{ID: "seed-storage", UserID: "user_1", GenerationType: "TEXT_TO_IMAGE", Model: seedreamModel, Count: 1, Size: "auto"}
	images, err := generateImages(context.Background(), s3TestStorage(), job, ProviderConfig{Model: seedreamModel, BaseURL: "https://api.apimart.ai/v1", AllowPrivateNetwork: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 1 || images[0].MediaStorage != MediaStorageS3 || !strings.HasPrefix(images[0].URL, "https://cdn.example.test/user_1/") {
		t.Fatalf("image storage was bypassed: %+v", images)
	}
}

func TestH3UploadFailureNeverSubmitsPaidJob(t *testing.T) {
	dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/uploads" {
			t.Fatalf("unexpected paid request: %s", r.URL)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"upload_failed","message":"private vendor details"}`)
	})
	ctx := withProviderLifecycle(context.Background(), func(context.Context) error { t.Fatal("upload entered SUBMITTING"); return nil }, func(context.Context, string) error { t.Fatal("upload entered SUBMITTED"); return nil }, nil)
	_, err := uploadH3Images(ctx, ProviderConfig{Model: h3Model, BaseURL: "https://h3.coolhs.com/api/v1", AllowPrivateNetwork: true}, []SourceImage{{Data: imageHistoryPNG(t), MimeType: "image/png"}})
	failure := classifyProviderFailure(err)
	if failure.Code != errorProviderUnavailable || !failure.Retryable || failure.HandoffUnknown || failure.ResolvedAfterSubmit || strings.Contains(failure.Message, "private") {
		t.Fatalf("wrong upload failure: %+v", failure)
	}
}

func TestH3ChecksAccountBeforeReferenceUpload(t *testing.T) {
	dedicatedTestClient(t, func(http.ResponseWriter, *http.Request) { t.Fatal("blocked account reached provider") })
	ctx := withProviderLifecycle(context.Background(), nil, nil, nil)
	providerLifecycleFromContext(ctx).checkPreparation = func(context.Context) error {
		return ContractFailure{Code: errorGenerationCancelled, Message: "账号已封禁"}
	}
	_, err := uploadH3Images(ctx, ProviderConfig{Model: h3Model, BaseURL: "https://h3.coolhs.com/api/v1", AllowPrivateNetwork: true}, nil)
	if failure := classifyProviderFailure(err); failure.Code != errorGenerationCancelled || failure.HandoffUnknown {
		t.Fatalf("account refusal lost before upload: %+v", failure)
	}
}

func TestH3TextVideoAndTerminalFailures(t *testing.T) {
	for _, status := range []string{"done", "failed", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/jobs" {
					t.Fatalf("text job uploaded or downloaded media: %s", r.URL)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if _, ok := body["images"]; ok {
					t.Fatal("text video unexpectedly has references")
				}
				fmt.Fprintf(w, `{"job":{"id":9,"status":%q,"has_video":true}}`, status)
			})
			job := GenerationJob{ID: "text-video", Model: h3Model, Count: 1, GenerationType: "TEXT_TO_VIDEO", Size: "736x736", DurationSeconds: sql.NullInt32{Int32: 4, Valid: true}}
			result, err := generateVideo(context.Background(), nil, job, ProviderConfig{Model: h3Model, BaseURL: "https://h3.coolhs.com/v1", AllowPrivateNetwork: true}, time.Millisecond)
			if status == "done" {
				if err != nil || result.PosterURL != "" || *result.Width != 736 || *result.DurationSeconds != 4 {
					t.Fatalf("bad text result: %+v %v", result, err)
				}
			} else if failure := classifyProviderFailure(err); failure.Code != errorProviderGenerationFailed || !failure.ResolvedAfterSubmit {
				t.Fatalf("wrong terminal failure: %+v", failure)
			}
		})
	}
}

func TestH3StringTaskIDSurvivesSubmissionAndPolling(t *testing.T) {
	for _, returnedID := range []string{"js70cdn18yza", "different-task"} {
		t.Run(returnedID, func(t *testing.T) {
			const taskID = "js70cdn18yza"
			requests := 0
			dedicatedTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				switch r.URL.Path {
				case "/api/v1/jobs":
					fmt.Fprintf(w, `{"job":{"id":%q,"status":"pending"}}`, taskID)
				case "/api/v1/jobs/" + taskID:
					fmt.Fprintf(w, `{"job":{"id":%q,"status":"done","has_video":true,"has_poster":true}}`, returnedID)
				default:
					t.Fatalf("task ID changed in request: %s", r.URL)
				}
			})
			requestID := ""
			ctx := withProviderLifecycle(context.Background(), nil, nil, func(_ context.Context, id string) error { requestID = id; return nil })
			job := GenerationJob{ID: "opaque-video", Model: h3Model, Count: 1, GenerationType: "TEXT_TO_VIDEO", Size: "1280x736", DurationSeconds: sql.NullInt32{Int32: 4, Valid: true}}
			result, err := generateVideo(ctx, nil, job, ProviderConfig{Model: h3Model, BaseURL: "https://h3.coolhs.com", AllowPrivateNetwork: true}, time.Millisecond)
			if requestID != taskID || requests != 2 {
				t.Fatalf("lost task identity: %q, %d requests", requestID, requests)
			}
			if returnedID != taskID {
				if failure := classifyProviderFailure(err); failure.Code != errorResultPersistFailed {
					t.Fatalf("accepted a different polled task: %+v", failure)
				}
				return
			}
			if err != nil || result.URL != "https://h3.coolhs.com/api/v1/jobs/"+taskID+"/video" || result.PosterURL != "https://h3.coolhs.com/api/v1/jobs/"+taskID+"/poster" {
				t.Fatalf("task ID changed in result: %+v, %v", result, err)
			}
		})
	}
}

func TestH3TaskIDValidation(t *testing.T) {
	for _, id := range []string{"js70cdn18yza", "Job_42-a", "42", strings.Repeat("a", 128)} {
		body, _ := json.Marshal(map[string]any{"job": map[string]any{"id": id, "status": "pending"}})
		job, err := parseH3Job(body)
		if err != nil || string(job.ID) != id {
			t.Errorf("valid task ID changed: %q => %q, %v", id, job.ID, err)
		}
	}
	for _, id := range []string{"42", "9223372036854775807"} {
		job, err := parseH3Job([]byte(`{"job":{"id":` + id + `,"status":"pending"}}`))
		if err != nil || string(job.ID) != id {
			t.Errorf("numeric task ID changed: %s => %q, %v", id, job.ID, err)
		}
	}
	for _, id := range []string{"", ".", "..", "a/../b", "a/b", `a\b`, "%2e%2e", "a%2fb", "a?b", "a#b", " a", "a ", "任务", "_a", "-a", strings.Repeat("a", 129)} {
		body, _ := json.Marshal(map[string]any{"job": map[string]any{"id": id, "status": "pending"}})
		if _, err := parseH3Job(body); err == nil {
			t.Errorf("unsafe task ID accepted: %q", id)
		}
	}
	for _, id := range []string{"null", "true", "{}", "[]", "0", "-1", "1.5", "1e3", "9223372036854775808"} {
		if _, err := parseH3Job([]byte(`{"job":{"id":` + id + `,"status":"pending"}}`)); err == nil {
			t.Errorf("invalid numeric task ID accepted: %s", id)
		}
	}
}
