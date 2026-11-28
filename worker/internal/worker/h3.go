package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"strconv"
	"time"
)

type h3Job struct {
	ID        int64   `json:"id"`
	Status    string  `json:"status"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Seconds   float64 `json:"seconds"`
	HasVideo  bool    `json:"has_video"`
	HasPoster bool    `json:"has_poster"`
}

func parseH3Job(body []byte) (h3Job, error) {
	var response struct {
		Job h3Job `json:"job"`
	}
	if json.Unmarshal(body, &response) != nil || response.Job.ID <= 0 || response.Job.Status == "" {
		return h3Job{}, ResultPersistError{Cause: errors.New("视频渠道未返回有效任务状态")}
	}
	return response.Job, nil
}

func generateH3Video(ctx context.Context, storage *Storage, job GenerationJob, provider ProviderConfig, pollInterval time.Duration) (VideoResult, error) {
	// The compatible /v1 API stops accepting the card after its last credit.
	// Native APIs keep existing tasks and their media accessible.
	provider.BaseURL = "https://h3.coolhs.com/api/v1"
	width, height := parseAspectSize(job.Size)
	body := map[string]any{
		"preset": "reference", "prompt": job.Prompt, "width": width, "height": height,
		"seconds": int(job.DurationSeconds.Int32),
	}
	if job.GenerationType == "IMAGE_TO_VIDEO" {
		images, err := storage.loadImageSources(context.WithValue(ctx, imageInputJobContextKey{}, job.ID), job.SourceImageURLs)
		if err != nil {
			return VideoResult{}, err
		}
		if err := validateDedicatedSources(images); err != nil {
			return VideoResult{}, err
		}
		refs, err := uploadH3Images(ctx, provider, images)
		if err != nil {
			return VideoResult{}, err
		}
		body["images"] = refs
	}
	createCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	response, err := postJSON(createCtx, endpoint(provider.BaseURL, "/jobs"), provider, body, idempotencyHeaders(job.ID, "h3-jobs"))
	cancel()
	if err != nil {
		return VideoResult{}, dedicatedSubmitFailure(err)
	}
	current, err := parseH3Job(response)
	if err != nil {
		return VideoResult{}, err
	}
	taskID := strconv.FormatInt(current.ID, 10)
	if err := recordProviderRequestID(ctx, taskID); err != nil {
		return VideoResult{}, err
	}
	for {
		switch current.Status {
		case "done":
			if !current.HasVideo {
				return VideoResult{}, ResultPersistError{Cause: errors.New("视频已过期或暂不可取")}
			}
			result := VideoResult{URL: endpoint(provider.BaseURL, "/jobs/"+taskID+"/video"), MediaStorage: MediaStorageUpstream}
			if current.HasPoster {
				result.PosterURL = endpoint(provider.BaseURL, "/jobs/"+taskID+"/poster")
			}
			if current.Width > 0 && current.Height > 0 {
				width, height = current.Width, current.Height
			}
			seconds := int(job.DurationSeconds.Int32)
			if current.Seconds > 0 {
				seconds = int(current.Seconds)
			}
			result.Width, result.Height, result.DurationSeconds = &width, &height, &seconds
			return result, nil
		case "failed", "cancelled":
			return VideoResult{}, providerTaskFailed("视频")
		case "pending", "running":
		default:
			return VideoResult{}, ResultPersistError{Cause: errors.New("视频渠道任务状态无效")}
		}
		if err := waitProviderPoll(ctx, pollInterval); err != nil {
			return VideoResult{}, err
		}
		response, err := fetchDedicatedStatus(ctx, provider, "/jobs/"+taskID)
		if err != nil {
			return VideoResult{}, err
		}
		current, err = parseH3Job(response)
		if err != nil {
			return VideoResult{}, err
		}
		if strconv.FormatInt(current.ID, 10) != taskID {
			return VideoResult{}, ResultPersistError{Cause: errors.New("视频渠道返回了不同任务")}
		}
	}
}

func uploadH3Images(ctx context.Context, provider ProviderConfig, images []SourceImage) ([]string, error) {
	if hooks := providerLifecycleFromContext(ctx); hooks != nil && hooks.checkPreparation != nil {
		if err := hooks.checkPreparation(ctx); err != nil {
			return nil, err
		}
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for index, image := range images {
		part, err := createImageFormFile(writer, "files", image, index)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(image.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	// Uploading a reference cannot consume a generation credit. Only /jobs may
	// move the paid task into SUBMITTING/SUBMITTED.
	uploadCtx, cancel := context.WithTimeout(withoutProviderLifecycle(ctx), 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(uploadCtx, http.MethodPost, endpoint(provider.BaseURL, "/uploads"), &body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+provider.APIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := doRequestWithClient(request, provider.httpClient())
	if err != nil {
		failure := classifyProviderFailure(dedicatedSubmitFailure(err))
		if failure.HandoffUnknown {
			failure = ContractFailure{Code: errorProviderUnavailable, Message: "参考图上传暂时失败，请稍后重试", Retryable: true}
		}
		return nil, failure
	}
	var uploaded struct {
		Items []struct {
			Ref string `json:"ref"`
		} `json:"items"`
	}
	if json.Unmarshal(response, &uploaded) != nil || len(uploaded.Items) != len(images) {
		return nil, ContractFailure{Code: errorProviderUnavailable, Message: "参考图上传结果无效", Retryable: true}
	}
	refs := make([]string, len(uploaded.Items))
	for index, item := range uploaded.Items {
		if item.Ref == "" {
			return nil, ContractFailure{Code: errorProviderUnavailable, Message: "参考图上传结果无效", Retryable: true}
		}
		refs[index] = item.Ref
	}
	return refs, nil
}
