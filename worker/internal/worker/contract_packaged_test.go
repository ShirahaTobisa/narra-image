package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGenerationContractPackagedExecutable(t *testing.T) {
	const childRoot = "NARRA_TEST_PACKAGED_GENERATION_ROOT"
	if root := os.Getenv(childRoot); root != "" {
		if actual := generationContractRoot(); actual != root {
			t.Fatalf("loaded source checkout instead of packaged contract: %q, want %q", actual, root)
		}
		for _, model := range []string{seedreamModel, h3Model} {
			limits, err := dedicatedModelLimits(model)
			if err != nil {
				t.Fatal(err)
			}
			if limits.Model != model || limits.MaxReferenceImages != 1 || limits.MaxOutputs != 1 {
				t.Fatalf("invalid packaged limits for %s: %+v", model, limits)
			}
		}
		return
	}

	installation := t.TempDir()
	root := filepath.Join(installation, "contracts", "generation", "v1")
	if err := os.CopyFS(root, os.DirFS(generationContractRoot())); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	packaged := filepath.Join(installation, filepath.Base(executable))
	if err := os.WriteFile(packaged, binary, 0o700); err != nil {
		t.Fatal(err)
	}
	workingDirectory := t.TempDir()
	run := func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, packaged, "-test.run=^TestGenerationContractPackagedExecutable$", "-test.timeout=15s")
		command.Dir = workingDirectory
		command.Env = append(os.Environ(), childRoot+"="+root)
		return command.CombinedOutput()
	}
	if output, err := run(); err != nil {
		t.Fatalf("packaged worker could not load model configuration: %v\n%s", err, output)
	}
	if err := os.Remove(filepath.Join(root, "dedicated-models.json")); err != nil {
		t.Fatal(err)
	}
	if output, err := run(); err == nil || !strings.Contains(string(output), "专用模型配置不可用") {
		t.Fatalf("incomplete package must fail instead of reading the source checkout: %v\n%s", err, output)
	}
}
