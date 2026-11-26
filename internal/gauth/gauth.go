// Package gauth signs gali in to Google through gcloud Application Default
// Credentials, so users do not have to assemble the gcloud commands themselves.
package gauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	admdir "google.golang.org/api/admin/directory/v1"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/cloudidentity/v1"
)

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform"

// GcloudInstallHint is shown when gcloud cannot be found.
const GcloudInstallHint = "Install the Google Cloud CLI (macOS: `brew install --cask google-cloud-sdk`, others: https://cloud.google.com/sdk/docs/install), then run `gali auth login` again"

// Scopes returns the scopes requested from gcloud. The groups scope is only
// needed by `check-visibility --group`, so it is opt-in.
func Scopes(groups bool) []string {
	scopes := []string{
		cloudPlatformScope,
		calendar.CalendarReadonlyScope,
		admdir.AdminDirectoryResourceCalendarReadonlyScope,
	}
	if groups {
		scopes = append(scopes, cloudidentity.CloudIdentityGroupsReadonlyScope)
	}
	return scopes
}

// GcloudConfigDir mirrors gcloud's own lookup of its configuration directory.
func GcloudConfigDir() (string, error) {
	if dir := os.Getenv("CLOUDSDK_CONFIG"); dir != "" {
		return dir, nil
	}
	return defaultGcloudConfigDir()
}

// defaultGcloudConfigDir is the directory gcloud uses without CLOUDSDK_CONFIG,
// which is also the only place Go's ADC lookup reads credentials from.
func defaultGcloudConfigDir() (string, error) {
	if runtime.GOOS == "windows" {
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "gcloud"), nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("unable to find home directory: %w", err)
	}
	return filepath.Join(home, ".config", "gcloud"), nil
}

// ADCFile is the path gcloud writes Application Default Credentials to.
func ADCFile() (string, error) {
	dir, err := GcloudConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "application_default_credentials.json"), nil
}

// QuotaProject returns the quota project stored in the ADC file, or "" when
// there is no ADC file or it has no quota project.
func QuotaProject() (string, error) {
	path, err := ADCFile()
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("unable to read %s: %w", path, err)
	}
	var adc struct {
		QuotaProjectID string `json:"quota_project_id"`
	}
	if err := json.Unmarshal(b, &adc); err != nil {
		return "", fmt.Errorf("unable to parse %s: %w", path, err)
	}
	return adc.QuotaProjectID, nil
}

type settings struct {
	Groups bool `json:"groups"`
}

func settingsFile() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("unable to find config directory: %w", err)
	}
	return filepath.Join(dir, "gali", "auth.json"), nil
}

// RememberedGroups reports whether the last successful login requested the
// groups scope. A re-login replaces the ADC grant, so without this a plain
// `gali auth login` would silently drop group access.
func RememberedGroups() (bool, error) {
	path, err := settingsFile()
	if err != nil {
		return false, err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("unable to read %s: %w", path, err)
	}
	var s settings
	if err := json.Unmarshal(b, &s); err != nil {
		return false, fmt.Errorf("unable to parse %s: %w", path, err)
	}
	return s.Groups, nil
}

func rememberGroups(groups bool) error {
	path, err := settingsFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("unable to create %s: %w", filepath.Dir(path), err)
	}
	b, err := json.Marshal(settings{Groups: groups})
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		return fmt.Errorf("unable to write %s: %w", path, err)
	}
	return nil
}

// LoginOptions configures Login.
type LoginOptions struct {
	// QuotaProject overrides the quota project. When empty, the quota project
	// of the current ADC file is kept.
	QuotaProject string
	// Groups requests the Cloud Identity Groups scope. Nil keeps the choice of
	// the previous login.
	Groups *bool
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// Login runs `gcloud auth application-default login` with the scopes gali needs
// and restores or sets the quota project afterwards.
func Login(opts LoginOptions) error {
	if path := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); path != "" {
		return fmt.Errorf("GOOGLE_APPLICATION_CREDENTIALS is set to %s and takes precedence over the login; unset it to use `gali auth login`", path)
	}
	// golang.org/x/oauth2's ADC lookup ignores CLOUDSDK_CONFIG, so credentials
	// written to a custom directory would never be used by gali.
	if dir := os.Getenv("CLOUDSDK_CONFIG"); dir != "" {
		def, err := defaultGcloudConfigDir()
		if err != nil {
			return err
		}
		if filepath.Clean(dir) != filepath.Clean(def) {
			return fmt.Errorf("CLOUDSDK_CONFIG is set to %s, but gali only reads Application Default Credentials from %s; unset CLOUDSDK_CONFIG to use `gali auth login`", dir, def)
		}
	}
	gcloud, err := exec.LookPath("gcloud")
	if err != nil {
		return fmt.Errorf("gcloud command not found. %s", GcloudInstallHint)
	}

	groups := false
	if opts.Groups != nil {
		groups = *opts.Groups
	} else if groups, err = RememberedGroups(); err != nil {
		return err
	}

	quotaProject := opts.QuotaProject
	if quotaProject == "" {
		// Ignore unreadable files: a broken ADC file is a reason to log in again.
		quotaProject, _ = QuotaProject()
	}

	run := func(args ...string) error {
		cmd := exec.Command(gcloud, args...)
		cmd.Stdin = opts.Stdin
		cmd.Stdout = opts.Stdout
		cmd.Stderr = opts.Stderr
		return cmd.Run()
	}

	if err := run("auth", "application-default", "login", "--scopes="+strings.Join(Scopes(groups), ",")); err != nil {
		return fmt.Errorf("gcloud login failed: %w", err)
	}
	if err := rememberGroups(groups); err != nil {
		return err
	}
	if quotaProject != "" {
		if err := run("auth", "application-default", "set-quota-project", quotaProject); err != nil {
			return fmt.Errorf("unable to set quota project %s: %w", quotaProject, err)
		}
	}
	return nil
}
