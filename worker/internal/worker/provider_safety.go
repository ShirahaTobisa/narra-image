package worker

import (
	"encoding/json"
	"strings"
)

func providerPolicyRejection(resolved bool) ContractFailure {
	return ContractFailure{
		Code: errorProviderPolicyRejected, Message: "渠道内容审核拒绝（moderation_blocked）",
		ResolvedAfterSubmit: resolved,
	}
}

func policyRejectionMessage(message string) bool {
	message = strings.ToLower(message)
	return strings.Contains(message, "moderation_blocked") ||
		strings.Contains(message, "content_policy_violation") ||
		(strings.Contains(message, "safety system") &&
			(strings.Contains(message, "reject") || strings.Contains(message, "block")))
}

func providerPolicyErrorBody(body []byte) bool {
	var value any
	if json.Unmarshal(body, &value) != nil {
		return policyRejectionMessage(string(body))
	}
	return providerPolicyRefusal(value)
}

// Inspect error/refusal fields, not arbitrary output text that may quote a policy code.
func providerPolicyRefusal(value any) bool {
	switch item := value.(type) {
	case []any:
		for _, child := range item {
			if providerPolicyRefusal(child) {
				return true
			}
		}
	case map[string]any:
		for _, key := range []string{"code", "type", "reason"} {
			field, _ := item[key].(string)
			switch strings.ToLower(field) {
			case "content_policy_violation", "moderation_blocked", "content_filter", "safety_violation", "refusal", "response.refusal.done":
				return true
			}
		}
		if message, _ := item["message"].(string); policyRejectionMessage(message) {
			return true
		}
		for _, key := range []string{"error", "response", "output", "content", "item", "incomplete_details"} {
			if providerPolicyRefusal(item[key]) {
				return true
			}
		}
	}
	return false
}
