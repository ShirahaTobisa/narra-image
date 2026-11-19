package worker

import "testing"

func TestWildcardChannelAcceptsAnyModelAndUsesItsDefault(t *testing.T) {
	fallback := []string{"*"}
	if !providerSupportsModel("gpt-image-2.6", "gpt-image-2.6-sunburst", fallback) {
		t.Fatal("兜底渠道应该接任何模型")
	}
	if got := upstreamModel("gpt-image-2.6", "gpt-image-2.6-sunburst", fallback); got != "gpt-image-2.6" {
		t.Fatalf("兜底渠道应改用默认模型出图，实际 %q", got)
	}
	if got := upstreamModel("gpt-image-2.6", "gpt-image-2", []string{"gpt-image-2", "*"}); got != "gpt-image-2" {
		t.Fatalf("单独列出的模型照原样发，实际 %q", got)
	}
}

func TestNormalChannelKeepsRequestedModel(t *testing.T) {
	models := []string{"gpt-image-2.6-flare"}
	if providerSupportsModel("gpt-image-2.6-sunburst", "gpt-image-2", models) {
		t.Fatal("普通渠道不该接没列出的模型")
	}
	if got := upstreamModel("gpt-image-2.6-sunburst", "gpt-image-2.6-flare", models); got != "gpt-image-2.6-flare" {
		t.Fatalf("普通渠道照用户选的模型发，实际 %q", got)
	}
	if got := upstreamModel("gpt-image-2.6-sunburst", "", models); got != "gpt-image-2.6-sunburst" {
		t.Fatalf("没选模型时用默认模型，实际 %q", got)
	}
}
