package worker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const safePolicyMessage = "渠道内容审核拒绝（moderation_blocked）"

func TestProviderPolicyHTTPRefusal(t *testing.T) {
	for _, body := range []string{
		`{"error":{"code":"content_policy_violation","message":"private prompt text"}}`,
		`{"error":{"code":"moderation_blocked","message":"private prompt text"}}`,
		`{"error":{"message":"Your request was rejected by the safety system: private prompt text"}}`,
		`moderation_blocked: private prompt text`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			_, err := generateWithImageGeneration(context.Background(), policyTestJob(), ProviderConfig{
				APIKey: "test-key", BaseURL: server.URL, AllowPrivateNetwork: true,
			})
			assertPolicyFailure(t, err, true)
		})
	}
}

func TestResponsesPolicyRefusal(t *testing.T) {
	const refusalSSE = "data: {\"type\":\"response.refusal.done\",\"refusal\":\"private prompt text\"}\n\n"
	for _, tc := range []struct {
		name, body       string
		stream, resolved bool
	}{
		{"failed JSON", `{"status":"failed","error":{"code":"content_policy_violation","message":"private prompt text"}}`, false, true},
		{"refusal JSON", `{"output":[{"type":"message","content":[{"type":"refusal","refusal":"private prompt text"}]}]}`, false, true},
		{"filtered JSON", `{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}`, false, true},
		{"failed SSE", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"moderation_blocked\",\"message\":\"private prompt text\"}}}\n\ndata: [DONE]\n", true, true},
		{"refusal SSE", refusalSSE + "data: [DONE]\n", true, true},
		{"refusal with EOF only", refusalSSE, true, false},
		{"completed SSE without DONE", refusalSSE + "data: {\"type\":\"response.completed\"}\n", true, true},
		{"failed SSE without DONE", refusalSSE + "data: {\"type\":\"response.failed\"}\n", true, true},
		{"incomplete SSE without DONE", refusalSSE + "data: {\"type\":\"response.incomplete\"}\n", true, true},
		{"malformed SSE before terminal", refusalSSE + "data: {broken-json}\n\ndata: [DONE]\n", true, false},
		{"malformed SSE after terminal", refusalSSE + "data: [DONE]\n\ndata: {broken-json}\n", true, false},
		{"image and refusal JSON", `{"output":[{"result":"iVBORfixture"},{"type":"message","content":[{"type":"refusal","refusal":"private prompt text"}]}]}`, false, false},
		{"image and refusal SSE", "data: {\"result\":\"iVBORfixture\"}\n\n" + refusalSSE + "data: [DONE]\n", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			baseURL := server.URL
			if tc.stream {
				baseURL += "/anyrouter"
			}
			job := policyTestJob()
			job.Count = 3
			_, err := generateWithResponsesImageTool(context.Background(), job, ProviderConfig{
				APIKey: "test-key", BaseURL: baseURL, AllowPrivateNetwork: true,
			}, nil)
			assertPolicyFailure(t, err, tc.resolved)
			if calls.Load() != 1 {
				t.Fatalf("refusal was resubmitted: %d requests", calls.Load())
			}
		})
	}
}

func TestResponsesPolicyPreservesPartialBatchUncertainty(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			_, _ = fmt.Fprint(w, `{"output":[{"type":"image_generation_call","result":"iVBORfixture"}]}`)
		} else {
			_, _ = fmt.Fprint(w, `{"error":{"code":"content_policy_violation"}}`)
		}
	}))
	defer server.Close()
	job := policyTestJob()
	job.Count = 3
	_, err := generateWithResponsesImageTool(context.Background(), job, ProviderConfig{
		APIKey: "test-key", BaseURL: server.URL, AllowPrivateNetwork: true,
	}, nil)
	assertPolicyFailure(t, err, false)
	if calls.Load() != 2 {
		t.Fatalf("unexpected batch requests: %d", calls.Load())
	}
}

func TestProviderPolicyGenericErrorsUnchanged(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprint(w, `{"error":{"code":"invalid_request_error","message":"unsupported size"}}`)
	}))
	defer server.Close()
	_, err := generateWithImageGeneration(context.Background(), policyTestJob(), ProviderConfig{
		APIKey: "test-key", BaseURL: server.URL, AllowPrivateNetwork: true,
	})
	failure := classifyProviderFailure(err)
	if failure.Code != errorProviderRequestInvalid || strings.Contains(failure.Message, "moderation_blocked") {
		t.Fatalf("ordinary error mislabeled as safety refusal: %+v", failure)
	}
}

func TestResponsesPolicyAllowsImagesAndPreservesOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		stream, ok bool
	}{
		{"image JSON", `{"output":[{"type":"image_generation_call","result":"iVBORfixture"}]}`, false, true},
		{"image SSE", "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"result\":\"iVBORfixture\"}]}}\n\ndata: [DONE]\n", true, true},
		{"generic failed JSON", `{"status":"failed","error":{"code":"server_error","message":"temporarily unavailable"}}`, false, false},
		{"ordinary text", `{"output":[{"type":"message","content":[{"type":"output_text","text":"content_policy_violation is an error code"}]}]}`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			baseURL := server.URL
			if tc.stream {
				baseURL += "/anyrouter"
			}
			payload, err := generateWithResponsesImageTool(context.Background(), policyTestJob(), ProviderConfig{
				APIKey: "test-key", BaseURL: baseURL, AllowPrivateNetwork: true,
			}, nil)
			if tc.ok {
				if err != nil || len(payload.Data) != 1 || payload.Data[0]["b64_json"] != "iVBORfixture" {
					t.Fatalf("normal image changed: %+v, %v", payload, err)
				}
			} else if err == nil || strings.Contains(err.Error(), "moderation_blocked") {
				t.Fatalf("non-policy failure mislabeled: %v", err)
			}
		})
	}
}

func policyTestJob() GenerationJob {
	return GenerationJob{ID: "policy-test-job", UserID: "policy-test-user", Count: 1, Model: "gpt-image-2", Prompt: "a cat", Size: "auto", ProviderMode: "BUILT_IN"}
}

func assertPolicyFailure(t *testing.T, err error, resolved bool) {
	t.Helper()
	failure := classifyProviderFailure(err)
	if failure.Code != errorProviderPolicyRejected || failure.Message != safePolicyMessage || failure.Retryable || failure.HandoffUnknown || failure.ResolvedAfterSubmit != resolved {
		t.Fatalf("expected safe final policy refusal (resolved=%v), got %+v", resolved, failure)
	}
}
