package gauth

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeGcloud puts a gcloud on PATH that appends its arguments to a log file.
func fakeGcloud(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake gcloud is a shell script")
	}
	dir := t.TempDir()
	logFile := filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\necho \"$*\" >> '" + logFile + "'\n"
	if err := os.WriteFile(filepath.Join(dir, "gcloud"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("CLOUDSDK_CONFIG", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	return logFile
}

func calls(t *testing.T, logFile string) []string {
	t.Helper()
	b, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func writeADC(t *testing.T, quotaProject string) {
	t.Helper()
	path, err := ADCFile()
	if err != nil {
		t.Fatal(err)
	}
	body := `{"type":"authorized_user","quota_project_id":"` + quotaProject + `"}`
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func login(t *testing.T, opts LoginOptions) {
	t.Helper()
	var out bytes.Buffer
	opts.Stdout, opts.Stderr = &out, &out
	if err := Login(opts); err != nil {
		t.Fatalf("Login: %v\n%s", err, out.String())
	}
}

func TestLoginRequestsGaliScopes(t *testing.T) {
	logFile := fakeGcloud(t)
	login(t, LoginOptions{})
	got := calls(t, logFile)
	want := "auth application-default login --scopes=" + strings.Join(Scopes(false), ",")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("calls = %q, want [%q]", got, want)
	}
}

func TestLoginKeepsExistingQuotaProject(t *testing.T) {
	logFile := fakeGcloud(t)
	writeADC(t, "my-project")
	login(t, LoginOptions{})
	got := calls(t, logFile)
	if len(got) != 2 || got[1] != "auth application-default set-quota-project my-project" {
		t.Fatalf("calls = %q", got)
	}
}

func TestLoginQuotaProjectFlagOverridesExisting(t *testing.T) {
	logFile := fakeGcloud(t)
	writeADC(t, "old-project")
	login(t, LoginOptions{QuotaProject: "new-project"})
	got := calls(t, logFile)
	if len(got) != 2 || got[1] != "auth application-default set-quota-project new-project" {
		t.Fatalf("calls = %q", got)
	}
}

func TestLoginRemembersGroupsScope(t *testing.T) {
	logFile := fakeGcloud(t)
	groups := true
	login(t, LoginOptions{Groups: &groups})
	login(t, LoginOptions{})
	groups = false
	login(t, LoginOptions{Groups: &groups})
	got := calls(t, logFile)
	withGroups := "auth application-default login --scopes=" + strings.Join(Scopes(true), ",")
	withoutGroups := "auth application-default login --scopes=" + strings.Join(Scopes(false), ",")
	want := []string{withGroups, withGroups, withoutGroups}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls = %q, want %q", got, want)
	}
}

func TestLoginRefusesWhenCredentialsOverrideADC(t *testing.T) {
	fakeGcloud(t)
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/key.json")
	if err := Login(LoginOptions{}); err == nil || !strings.Contains(err.Error(), "GOOGLE_APPLICATION_CREDENTIALS") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoginWithoutGcloudExplainsInstall(t *testing.T) {
	fakeGcloud(t)
	t.Setenv("PATH", t.TempDir())
	if err := Login(LoginOptions{}); err == nil || !strings.Contains(err.Error(), "google-cloud-sdk") {
		t.Fatalf("err = %v", err)
	}
}
