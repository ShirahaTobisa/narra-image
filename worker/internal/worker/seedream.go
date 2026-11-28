package worker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strings"
	"time"
)

var seedreamRatios = []string{"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "2:1", "1:2"}

// Size in this application encodes an aspect ratio. Never forward pixel counts:
// APIMart's auto/default and exact pixels can silently reserve a higher tier.
func seedreamRequestSize(job GenerationJob) (string, error) {
	size := strings.TrimSpace(job.Size)
	if job.AspectRatio.Valid && strings.TrimSpace(job.AspectRatio.String) != "" {
		size = strings.TrimSpace(job.AspectRatio.String)
	}
	if size == "" || size == "auto" || size == "1K" {
		return "1K", nil
	}
	width, height := parseAspectSize(strings.ReplaceAll(size, ":", "x"))
	if width > 0 && height > 0 {
		for _, ratio := range seedreamRatios {
			w, h := parseAspectSize(strings.ReplaceAll(ratio, ":", "x"))
			if math.Abs(float64(width)/float64(height)/(float64(w)/float64(h))-1) < 0.02 {
				return ratio, nil
			}
		}
	}
	return "", ContractFailure{Code: errorProviderRequestInvalid, Message: "Seedream 不支持该图片比例"}
}

type seedreamTaskResponse struct {
	Data struct {
		Status string `json:"status"`
		Error  struct {
			Reason string `json:"reason"`
		} `json:"error"`
		Result struct {
			Images []struct {
				URLs  []string `json:"url"`
				Sizes []string `json:"sizes"`
			} `json:"images"`
		} `json:"result"`
	} `json:"data"`
}

func generateSeedream(ctx context.Context, job GenerationJob, provider ProviderConfig, images []SourceImage, pollInterval time.Duration) (imagePayload, error) {
	size, err := seedreamRequestSize(job)
	if err != nil {
		return imagePayload{}, err
	}
	limits, err := dedicatedModelLimits(seedreamModel)
	if err != nil {
		return imagePayload{}, err
	}
	body := map[string]any{"model": seedreamModel, "prompt": job.Prompt, "n": 1, "size": size, "output_format": outputFormat(job), "nsfw_check": false}
	if size != limits.Resolution {
		body["resolution"] = limits.Resolution
	}
	if len(images) > 0 {
		body["image_urls"] = []string{imageDataURL(images[0])}
	}
	response, err := postJSON(ctx, endpoint(provider.BaseURL, "/images/generations"), provider, body, idempotencyHeaders(job.ID, "images-generations"))
	if err != nil {
		return imagePayload{}, dedicatedSubmitFailure(err)
	}
	var submitted struct {
		Data []struct {
			TaskID string `json:"task_id"`
		} `json:"data"`
	}
	if json.Unmarshal(response, &submitted) != nil || len(submitted.Data) != 1 || strings.TrimSpace(submitted.Data[0].TaskID) == "" {
		return imagePayload{}, ResultPersistError{Cause: errors.New("图片渠道未返回有效任务编号")}
	}
	taskID := submitted.Data[0].TaskID
	if err := recordProviderRequestID(ctx, taskID); err != nil {
		return imagePayload{}, err
	}
	for {
		response, err := fetchDedicatedStatus(ctx, provider, "/tasks/"+url.PathEscape(taskID))
		if err != nil {
			return imagePayload{}, err
		}
		var task seedreamTaskResponse
		if json.Unmarshal(response, &task) != nil {
			return imagePayload{}, ResultPersistError{Cause: errors.New("图片渠道任务状态无效")}
		}
		switch task.Data.Status {
		case "completed":
			payload := imagePayload{}
			for _, group := range task.Data.Result.Images {
				for index, rawURL := range group.URLs {
					item := map[string]any{"url": rawURL}
					if len(group.Sizes) == len(group.URLs) {
						item["size"] = group.Sizes[index]
					}
					payload.Data = append(payload.Data, item)
				}
			}
			if len(payload.Data) != limits.MaxOutputs {
				return imagePayload{}, ResultPersistError{Cause: errors.New("图片渠道返回的结果数量无效")}
			}
			return payload, nil
		case "failed", "cancelled", "canceled":
			if task.Data.Error.Reason == "content_policy_violation" {
				return imagePayload{}, providerPolicyRejection(true)
			}
			return imagePayload{}, providerTaskFailed("图片")
		case "pending", "processing":
		default:
			return imagePayload{}, ResultPersistError{Cause: errors.New("图片渠道任务状态无效")}
		}
		if err := waitProviderPoll(ctx, pollInterval); err != nil {
			return imagePayload{}, err
		}
	}
}
