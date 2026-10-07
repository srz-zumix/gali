package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestCopilotExtensionInstallCommand(t *testing.T) {
	command, remaining, err := rootCmd.Find([]string{"copilot", "extension", "install"})
	if err != nil {
		t.Fatal(err)
	}
	if command.CommandPath() != "gali copilot extension install" || len(remaining) != 0 {
		t.Fatalf("unexpected command: %s, remaining: %v", command.CommandPath(), remaining)
	}
	for _, name := range []string{"scope", "prefix", "ref", "dry-run", "force"} {
		if command.Flags().Lookup(name) == nil {
			t.Errorf("missing install flag --%s", name)
		}
	}
}

func TestCopilotExtensionList(t *testing.T) {
	command := NewCopilotCmd()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetArgs([]string{"extension", "list"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	want := "gali-calendar\thttps://github.com/srz-zumix/gali/tree/main/.github/extensions/gali\tmain\n"
	if output.String() != want {
		t.Fatalf("list output = %q, want %q", output.String(), want)
	}
}

func TestCopilotExtensionInstallHelp(t *testing.T) {
	command := NewCopilotCmd()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetArgs([]string{"extension", "install", "--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "copilot extension install [name...]") {
		t.Fatalf("unexpected install help: %s", output.String())
	}
}
