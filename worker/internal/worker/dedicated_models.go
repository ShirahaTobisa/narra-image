package worker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

const seedreamModel = "seedream-5-5"
const h3Model = "h3"

type DedicatedModelLimits struct {
	Model              string   `json:"model"`
	Kind               string   `json:"kind"`
	Resolution         string   `json:"resolution"`
	MaxReferenceImages int      `json:"maxReferenceImages"`
	MaxOutputs         int      `json:"maxOutputs"`
	Formats            []string `json:"formats"`
	Durations          []int    `json:"durations"`
	MaxEdge            int      `json:"maxEdge"`
}

func isDedicatedModel(model string) bool {
	model = strings.TrimSpace(model)
	return model == seedreamModel || model == h3Model
}

func dedicatedModelLimits(model string) (DedicatedModelLimits, error) {
	contract, err := sharedContract()
	if err == nil {
		for _, limits := range contract.DedicatedModels {
			if limits.Model == model {
				return limits, nil
			}
		}
	}
	return DedicatedModelLimits{}, ContractFailure{Code: errorProviderNotConfigured, Message: "专用模型配置不可用"}
}

// A dedicated model must keep its identity and its configured vendor. A wildcard
// or similarly named host must never turn it into a GPT request.
func validateDedicatedProvider(model string, provider ProviderConfig) error {
	model = strings.TrimSpace(model)
	if !isDedicatedModel(model) && !isDedicatedModel(provider.Model) {
		return nil
	}
	parsed, err := url.Parse(strings.TrimSpace(provider.BaseURL))
	valid := err == nil && parsed.Scheme == "https" && parsed.User == nil &&
		parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Fragment == "" &&
		parsed.RawPath == "" && (parsed.Port() == "" || parsed.Port() == "443")
	if valid {
		path := strings.TrimRight(parsed.Path, "/")
		switch model {
		case seedreamModel:
			valid = strings.EqualFold(parsed.Hostname(), "api.apimart.ai") && path == "/v1"
		case h3Model:
			valid = strings.EqualFold(parsed.Hostname(), "h3.coolhs.com") &&
				(path == "" || path == "/v1" || path == "/api/v1")
		default:
			valid = false
		}
	}
	if !valid || model != strings.TrimSpace(provider.Model) {
		return ContractFailure{Code: errorModelNotSupported, Message: "所选渠道未配置该模型对应的供应商"}
	}
	return nil
}

func validateDedicatedJob(job GenerationJob) error {
	if !isDedicatedModel(job.Model) {
		return nil
	}
	limits, err := dedicatedModelLimits(job.Model)
	if err != nil {
		return err
	}
	invalid := func(message string) error {
		return ContractFailure{Code: errorProviderRequestInvalid, Message: message}
	}
	if job.Count != limits.MaxOutputs || len(job.SourceImageURLs) > limits.MaxReferenceImages {
		return invalid("该模型每次仅生成一个结果，最多使用一张参考图")
	}
	imageInput := job.GenerationType == "IMAGE_TO_IMAGE" || job.GenerationType == "IMAGE_TO_VIDEO"
	if imageInput && len(job.SourceImageURLs) == 0 {
		return invalid("请先上传参考图")
	}
	if !imageInput && len(job.SourceImageURLs) != 0 {
		return invalid("带参考图时请选择图生图或图生视频")
	}
	if limits.Kind == "image" {
		if !isImageGeneration(job) || !slices.Contains(limits.Formats, outputFormat(job)) {
			return invalid("Seedream 仅支持生成 PNG 或 JPEG 图片")
		}
		_, err := seedreamRequestSize(job)
		return err
	}
	width, height := parseAspectSize(job.Size)
	if (job.GenerationType != "TEXT_TO_VIDEO" && job.GenerationType != "IMAGE_TO_VIDEO") ||
		!job.DurationSeconds.Valid || !slices.Contains(limits.Durations, int(job.DurationSeconds.Int32)) ||
		width <= 0 || height <= 0 || width > limits.MaxEdge || height > limits.MaxEdge {
		return invalid("H3 仅支持 4、6、8 秒视频，尺寸最长边不能超过 1440")
	}
	return nil
}

func validateDedicatedSources(images []SourceImage) error {
	for _, image := range images {
		mimeType, err := validatedImageMimeType(image.MimeType, image.Data)
		if err != nil || len(image.Data) > 20*1024*1024 ||
			!slices.Contains([]string{"image/png", "image/jpeg", "image/webp", "image/gif"}, mimeType) ||
			readImageDimensions(image.Data) == nil {
			return ContractFailure{Code: errorSourceImageInvalid, Message: "参考图须为有效的 PNG、JPEG、WebP 或 GIF，且不超过 20MiB"}
		}
	}
	return nil
}

func withoutProviderLifecycle(ctx context.Context) context.Context {
	return context.WithValue(ctx, providerLifecycleContextKey{}, (*providerLifecycleHooks)(nil))
}

func waitProviderPoll(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Poll errors do not establish the outcome of the already accepted paid task.
func fetchDedicatedStatus(ctx context.Context, provider ProviderConfig, path string) ([]byte, error) {
	body, err := getWithAuth(withoutProviderLifecycle(ctx), endpoint(provider.BaseURL, path), provider)
	if err != nil {
		return nil, ContractFailure{Code: errorHandoffUnknown, HandoffUnknown: true, Message: "渠道任务状态暂时无法确认，请保留任务编号"}
	}
	return body, nil
}

// Do not expose vendor response bodies/URLs or mistake ordinary HTTP errors for
// a content refusal. Explicit policy errors retain their existing classification.
func dedicatedSubmitFailure(err error) error {
	if err == nil {
		return nil
	}
	failure := classifyProviderFailure(err)
	var httpFailure ProviderHTTPError
	if errors.As(err, &httpFailure) && failure.Code == errorProviderPolicyRejected {
		if httpFailure.StatusCode >= http.StatusBadRequest && httpFailure.StatusCode < http.StatusInternalServerError {
			failure = ContractFailure{Code: errorProviderRequestInvalid}
		} else {
			failure = ContractFailure{Code: errorHandoffUnknown, HandoffUnknown: true}
		}
	}
	if contract, loadErr := sharedContract(); loadErr == nil {
		if definition, ok := contract.Errors[failure.Code]; ok {
			failure.Message = definition.UserMessage
		}
	}
	return failure
}

func providerTaskFailed(kind string) ContractFailure {
	return ContractFailure{Code: errorProviderGenerationFailed, Message: fmt.Sprintf("%s生成失败，请稍后重试", kind), ResolvedAfterSubmit: true}
}
