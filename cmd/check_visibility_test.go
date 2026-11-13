package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/cloudidentity/v1"
)

func TestCheckVisibilityNoTargetsDoesNotAuthenticate(t *testing.T) {
	called := false
	cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
		called = true
		return nil, nil, fmt.Errorf("should not authenticate")
	})
	var stdout, stderr strings.Builder
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{"--format", "json"})

	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("authentication was attempted with no targets")
	}
	var report visibilityReport
	if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
		t.Fatalf("invalid JSON output %q: %v", stdout.String(), err)
	}
	if len(report.Visible) != 0 || len(report.NotVisible) != 0 || len(report.Undetermined) != 0 || len(report.UnresolvedGroups) != 0 {
		t.Fatalf("unexpected empty-target report: %#v", report)
	}
	var output struct {
		Counts map[string]int `json:"counts"`
	}
	if err := json.Unmarshal([]byte(stdout.String()), &output); err != nil {
		t.Fatal(err)
	}
	if len(output.Counts) != 4 {
		t.Fatalf("counts = %v, want four zero counts", output.Counts)
	}
	for _, status := range []string{"visible", "not_visible", "undetermined", "unresolved_groups"} {
		if count, ok := output.Counts[status]; !ok || count != 0 {
			t.Fatalf("counts = %v, want zero for %s", output.Counts, status)
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestCheckVisibilityWritesPartialJSONAndReturnsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Query().Get("fields") != "accessRole" || r.URL.Query().Get("maxResults") != "1" {
			t.Errorf("unexpected Calendar request: %s %s", r.Method, r.URL.String())
		}
		calendarID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/calendars/"), "/events")
		switch calendarID {
		case "alice@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"reader","items":[]}`)
		case "bob@example.com":
			http.Error(w, `{"error":{"code":404,"message":"not found"}}`, http.StatusNotFound)
		case "charlie@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"freeBusyReader","items":[]}`)
		case "dave@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"newRole","items":[]}`)
		case "eve@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"writerWithoutPrivateAccess","items":[]}`)
		case "frank@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"writer","items":[]}`)
		case "grace@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"owner","items":[]}`)
		case "harry@example.com":
			_, _ = fmt.Fprint(w, `{"accessRole":"none","items":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	cmd := newCheckVisibilityCmd(func(ctx context.Context, includeGroups bool, _ io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
		if includeGroups {
			t.Fatal("unexpected group service request")
		}
		service, err := calendar.New(&http.Client{})
		if err != nil {
			return nil, nil, err
		}
		service.BasePath = server.URL + "/"
		return service, nil, nil
	})
	var stdout, stderr strings.Builder
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{
		"--attendee", "Bob@example.com",
		"--attendee", "alice@example.com",
		"--attendee", "ALICE@example.com",
		"--attendee", "charlie@example.com",
		"--attendee", "dave@example.com",
		"--attendee", "eve@example.com",
		"--attendee", "frank@example.com",
		"--attendee", "grace@example.com",
		"--attendee", "harry@example.com",
		"--format", "json",
	})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("Execute() error = nil, want partial-result error")
	}
	var report visibilityReport
	if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
		t.Fatalf("partial output is not valid JSON %q: %v", stdout.String(), err)
	}
	if len(report.Visible) != 4 ||
		report.Visible[0].Email != "alice@example.com" || report.Visible[0].AccessRole != "reader" ||
		report.Visible[1].Email != "eve@example.com" || report.Visible[1].AccessRole != "writerWithoutPrivateAccess" ||
		report.Visible[2].Email != "frank@example.com" || report.Visible[2].AccessRole != "writer" ||
		report.Visible[3].Email != "grace@example.com" || report.Visible[3].AccessRole != "owner" {
		t.Fatalf("visible = %#v", report.Visible)
	}
	if len(report.NotVisible) != 2 ||
		report.NotVisible[0].Email != "charlie@example.com" || report.NotVisible[0].AccessRole != "freeBusyReader" ||
		report.NotVisible[1].Email != "harry@example.com" || report.NotVisible[1].AccessRole != "none" {
		t.Fatalf("not visible = %#v", report.NotVisible)
	}
	if len(report.Undetermined) != 2 || report.Undetermined[0].Email != "bob@example.com" || report.Undetermined[1].Email != "dave@example.com" {
		t.Fatalf("undetermined = %#v", report.Undetermined)
	}
	if len(report.UnresolvedGroups) != 0 {
		t.Fatalf("unexpected report categories: %#v", report)
	}
	if want := (visibilityCounts{Visible: 4, NotVisible: 2, Undetermined: 2}); report.Counts != want {
		t.Fatalf("counts = %#v, want %#v", report.Counts, want)
	}
	if strings.Contains(stdout.String(), err.Error()) {
		t.Fatalf("error text contaminated JSON output: %q", stdout.String())
	}
}

func TestCheckVisibilityRejectsInvalidInputBeforeAuthentication(t *testing.T) {
	cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
		t.Fatal("authentication called for invalid input")
		return nil, nil, nil
	})
	var stdout strings.Builder
	cmd.SetOut(&stdout)
	cmd.SetArgs([]string{"--attendee", "Not an email"})

	if err := cmd.Execute(); err == nil {
		t.Fatal("Execute() error = nil, want validation error")
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want empty", stdout.String())
	}
}

func TestCheckVisibilityContinuesWhenGroupLookupFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/groups:lookup"):
			http.Error(w, `{"error":{"code":403,"message":"permission denied"}}`, http.StatusForbidden)
		case strings.Contains(r.URL.Path, "/calendars/alice@example.com/events"):
			_, _ = fmt.Fprint(w, `{"accessRole":"reader","items":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	cmd := newCheckVisibilityCmd(func(ctx context.Context, includeGroups bool, _ io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
		if !includeGroups {
			t.Fatal("group authentication was not requested")
		}
		calendarService, err := calendar.New(&http.Client{})
		if err != nil {
			return nil, nil, err
		}
		calendarService.BasePath = server.URL + "/"
		groupService, err := cloudidentity.New(&http.Client{})
		if err != nil {
			return nil, nil, err
		}
		groupService.BasePath = server.URL + "/"
		return calendarService, groupService, nil
	})
	var stdout, stderr strings.Builder
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{"--attendee", "alice@example.com", "--group", "team@example.com", "--format", "json"})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("Execute() error = nil, want incomplete group error")
	}
	var report visibilityReport
	if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
		t.Fatalf("partial output is not valid JSON %q: %v", stdout.String(), err)
	}
	if len(report.Visible) != 1 || report.Visible[0].Email != "alice@example.com" {
		t.Fatalf("visible = %#v", report.Visible)
	}
	if len(report.UnresolvedGroups) != 1 || report.UnresolvedGroups[0].Group != "team@example.com" {
		t.Fatalf("unresolved groups = %#v", report.UnresolvedGroups)
	}
	if !strings.Contains(stderr.String(), "separate OAuth token") {
		t.Fatalf("stderr = %q, want authentication-account note", stderr.String())
	}
}

func TestCheckVisibilityFiltersRolesAndKeepsFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/groups:lookup" {
			http.Error(w, `{"error":{"code":403,"message":"permission denied"}}`, http.StatusForbidden)
			return
		}
		switch strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/calendars/"), "/events") {
		case "alice@example.com":
			fmt.Fprint(w, `{"accessRole":"reader"}`)
		case "bob@example.com":
			fmt.Fprint(w, `{"accessRole":"writer"}`)
		case "carol@example.com":
			fmt.Fprint(w, `{"accessRole":"freeBusyReader"}`)
		case "dave@example.com":
			fmt.Fprint(w, `{"accessRole":"unknownRole"}`)
		case "eve@example.com":
			http.Error(w, `{"error":{"code":404,"message":"not found"}}`, http.StatusNotFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	getServices := func(_ context.Context, _ bool, _ io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
		calendarService, err := calendar.New(&http.Client{})
		if err != nil {
			return nil, nil, err
		}
		calendarService.BasePath = server.URL + "/"
		groupService, err := cloudidentity.New(&http.Client{})
		if err != nil {
			return nil, nil, err
		}
		groupService.BasePath = server.URL + "/"
		return calendarService, groupService, nil
	}

	for _, tt := range []struct {
		name        string
		roleArgs    []string
		wantVisible []string
		wantHidden  []string
	}{
		{"single role", []string{"--role", "reader"}, []string{"alice@example.com"}, nil},
		{"multiple roles", []string{"--role", "writer", "--role", "freeBusyReader"}, []string{"bob@example.com"}, []string{"carol@example.com"}},
		{"no matches", []string{"--role", "none"}, nil, nil},
		{"exclude role", []string{"--exclude-role", "writer"}, []string{"alice@example.com"}, []string{"carol@example.com"}},
		{"exclude multiple roles", []string{"--exclude-role", "writer", "--exclude-role", "freeBusyReader"}, []string{"alice@example.com"}, nil},
		{"include and exclude", []string{"--role", "reader", "--role", "freeBusyReader", "--exclude-role", "writer"}, []string{"alice@example.com"}, []string{"carol@example.com"}},
		{"exclude all matched roles", []string{"--exclude-role", "reader", "--exclude-role", "writer", "--exclude-role", "freeBusyReader"}, nil, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cmd := newCheckVisibilityCmd(getServices)
			var stdout, stderr strings.Builder
			cmd.SetOut(&stdout)
			cmd.SetErr(&stderr)
			args := []string{
				"--attendee", "alice@example.com", "--attendee", "bob@example.com",
				"--attendee", "carol@example.com", "--attendee", "dave@example.com",
				"--attendee", "eve@example.com", "--group", "team@example.com",
				"--format", "json",
			}
			cmd.SetArgs(append(args, tt.roleArgs...))
			if err := cmd.Execute(); err == nil {
				t.Fatal("expected incomplete-result error")
			}
			var report visibilityReport
			if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
				t.Fatalf("invalid JSON %q: %v", stdout.String(), err)
			}
			if report.Visible == nil || report.NotVisible == nil || report.Undetermined == nil || report.UnresolvedGroups == nil {
				t.Fatalf("expected arrays for all result categories: %s", stdout.String())
			}
			if len(report.Visible) != len(tt.wantVisible) || len(report.NotVisible) != len(tt.wantHidden) {
				t.Fatalf("unexpected filtered results: %#v", report)
			}
			for i, email := range tt.wantVisible {
				if report.Visible[i].Email != email {
					t.Fatalf("visible = %#v, want %v", report.Visible, tt.wantVisible)
				}
			}
			for i, email := range tt.wantHidden {
				if report.NotVisible[i].Email != email {
					t.Fatalf("not_visible = %#v, want %v", report.NotVisible, tt.wantHidden)
				}
			}
			if len(report.Undetermined) != 2 || report.Undetermined[0].Email != "dave@example.com" ||
				report.Undetermined[1].Email != "eve@example.com" ||
				len(report.UnresolvedGroups) != 1 || report.UnresolvedGroups[0].Group != "team@example.com" {
				t.Fatalf("filtered out failures: %#v", report)
			}
			wantCounts := visibilityCounts{
				Visible: len(tt.wantVisible), NotVisible: len(tt.wantHidden), Undetermined: 2, UnresolvedGroups: 1,
			}
			if report.Counts != wantCounts {
				t.Fatalf("counts = %#v, want %#v", report.Counts, wantCounts)
			}
		})
	}

	resultEmails := func(results []visibilityResult) []string {
		emails := make([]string, len(results))
		for i, result := range results {
			emails[i] = result.Email
		}
		return emails
	}
	for _, tt := range []struct {
		name         string
		filterArgs   []string
		visible      []string
		notVisible   []string
		undetermined []string
		unresolved   []string
	}{
		{"visible only", []string{"--status", "visible"}, []string{"alice@example.com", "bob@example.com"}, nil, nil, nil},
		{"not visible only", []string{"--status", "not_visible"}, nil, []string{"carol@example.com"}, nil, nil},
		{"unresolved groups only", []string{"--status", "unresolved_groups"}, nil, nil, nil, []string{"team@example.com"}},
		{"failures only", []string{"--status", "undetermined", "--status", "unresolved_groups"}, nil, nil, []string{"dave@example.com", "eve@example.com"}, []string{"team@example.com"}},
		{"exclude failures", []string{"--exclude-status", "undetermined", "--exclude-status", "unresolved_groups"}, []string{"alice@example.com", "bob@example.com"}, []string{"carol@example.com"}, nil, nil},
		{"include and exclude", []string{"--status", "visible", "--status", "undetermined", "--exclude-status", "not_visible"}, []string{"alice@example.com", "bob@example.com"}, nil, []string{"dave@example.com", "eve@example.com"}, nil},
		{"role and status", []string{"--role", "reader", "--status", "visible", "--status", "undetermined"}, []string{"alice@example.com"}, nil, []string{"dave@example.com", "eve@example.com"}, nil},
		{"exclude all", []string{"--exclude-status", "visible", "--exclude-status", "not_visible", "--exclude-status", "undetermined", "--exclude-status", "unresolved_groups"}, nil, nil, nil, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cmd := newCheckVisibilityCmd(getServices)
			var stdout, stderr strings.Builder
			cmd.SetOut(&stdout)
			cmd.SetErr(&stderr)
			args := []string{
				"--attendee", "alice@example.com", "--attendee", "bob@example.com",
				"--attendee", "carol@example.com", "--attendee", "dave@example.com",
				"--attendee", "eve@example.com", "--group", "team@example.com",
				"--format", "json",
			}
			cmd.SetArgs(append(args, tt.filterArgs...))
			err := cmd.Execute()
			if err == nil || !strings.Contains(err.Error(), "2 undetermined calendars and 1 unresolved groups") {
				t.Fatalf("expected unfiltered failure counts, got %v", err)
			}
			var report visibilityReport
			if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
				t.Fatalf("invalid JSON %q: %v", stdout.String(), err)
			}
			if report.Visible == nil || report.NotVisible == nil || report.Undetermined == nil || report.UnresolvedGroups == nil {
				t.Fatalf("expected arrays for all result categories: %s", stdout.String())
			}
			unresolved := make([]string, len(report.UnresolvedGroups))
			for i, group := range report.UnresolvedGroups {
				unresolved[i] = group.Group
			}
			if !slices.Equal(resultEmails(report.Visible), tt.visible) ||
				!slices.Equal(resultEmails(report.NotVisible), tt.notVisible) ||
				!slices.Equal(resultEmails(report.Undetermined), tt.undetermined) ||
				!slices.Equal(unresolved, tt.unresolved) {
				t.Fatalf("unexpected filtered results: %#v", report)
			}
			wantCounts := visibilityCounts{
				Visible: len(tt.visible), NotVisible: len(tt.notVisible),
				Undetermined: len(tt.undetermined), UnresolvedGroups: len(tt.unresolved),
			}
			if report.Counts != wantCounts {
				t.Fatalf("counts = %#v, want %#v", report.Counts, wantCounts)
			}
		})
	}

	t.Run("text output", func(t *testing.T) {
		cmd := newCheckVisibilityCmd(getServices)
		var stdout, stderr strings.Builder
		cmd.SetOut(&stdout)
		cmd.SetErr(&stderr)
		cmd.SetArgs([]string{
			"--attendee", "alice@example.com", "--attendee", "bob@example.com",
			"--attendee", "eve@example.com", "--group", "team@example.com", "--exclude-role", "writer",
		})
		if err := cmd.Execute(); err == nil {
			t.Fatal("expected incomplete-result error")
		}
		for _, want := range []string{"alice@example.com", "eve@example.com", "team@example.com"} {
			if !strings.Contains(stdout.String(), want) {
				t.Fatalf("output %q does not contain %q", stdout.String(), want)
			}
		}
		for _, want := range []string{"Visible (1):", "Not visible (0):", "Undetermined (1):", "Unresolved groups (1):"} {
			if !strings.Contains(stdout.String(), want) {
				t.Fatalf("output %q does not contain %q", stdout.String(), want)
			}
		}
		if strings.Contains(stdout.String(), "bob@example.com") {
			t.Fatalf("output includes excluded role: %q", stdout.String())
		}
	})

	t.Run("status filter text output", func(t *testing.T) {
		cmd := newCheckVisibilityCmd(getServices)
		var stdout, stderr strings.Builder
		cmd.SetOut(&stdout)
		cmd.SetErr(&stderr)
		cmd.SetArgs([]string{
			"--attendee", "alice@example.com", "--attendee", "bob@example.com",
			"--attendee", "eve@example.com", "--group", "team@example.com",
			"--status", "visible", "--exclude-role", "writer",
		})
		err := cmd.Execute()
		if err == nil || !strings.Contains(err.Error(), "1 undetermined calendars and 1 unresolved groups") {
			t.Fatalf("expected hidden failures to remain errors, got %v", err)
		}
		if want := "Visible (1):\n  alice@example.com (reader)\n"; stdout.String() != want {
			t.Fatalf("stdout = %q, want %q", stdout.String(), want)
		}
	})

	t.Run("unresolved groups text output", func(t *testing.T) {
		cmd := newCheckVisibilityCmd(getServices)
		var stdout, stderr strings.Builder
		cmd.SetOut(&stdout)
		cmd.SetErr(&stderr)
		cmd.SetArgs([]string{
			"--attendee", "alice@example.com", "--group", "team@example.com",
			"--status", "unresolved_groups",
		})
		if err := cmd.Execute(); err == nil {
			t.Fatal("expected unresolved group error")
		}
		if !strings.HasPrefix(stdout.String(), "Unresolved groups (1):\n  team@example.com ") ||
			strings.Contains(stdout.String(), "Visible (") {
			t.Fatalf("unexpected output %q", stdout.String())
		}
	})
}

func TestCheckVisibilityRoleFilterValidation(t *testing.T) {
	for _, flag := range []string{"--role", "--exclude-role"} {
		for _, role := range []string{"invalid", "", "Reader"} {
			t.Run(flag+"/"+role, func(t *testing.T) {
				cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
					t.Fatal("authentication called for invalid role")
					return nil, nil, nil
				})
				var stdout strings.Builder
				cmd.SetOut(&stdout)
				cmd.SetArgs([]string{flag, role, "--format", "json"})
				if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "invalid "+flag) {
					t.Fatalf("expected invalid %s error, got %v", flag, err)
				}
				if stdout.Len() != 0 {
					t.Fatalf("stdout = %q, want empty", stdout.String())
				}
			})
		}
	}
}

func TestCheckVisibilityConflictingRoleFilters(t *testing.T) {
	for _, args := range [][]string{
		{"--role", "reader", "--exclude-role", "reader"},
		{"--exclude-role", "writer", "--role", "reader", "--role", "writer"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
				t.Fatal("authentication called for conflicting roles")
				return nil, nil, nil
			})
			var stdout strings.Builder
			cmd.SetOut(&stdout)
			cmd.SetArgs(append(args, "--attendee", "alice@example.com", "--format", "json"))
			if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "both --role and --exclude-role") {
				t.Fatalf("expected conflicting role error, got %v", err)
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q, want empty", stdout.String())
			}
		})
	}
}

func TestCheckVisibilityStatusFilterValidation(t *testing.T) {
	for _, flag := range []string{"--status", "--exclude-status"} {
		for _, status := range []string{"invalid", "", "Visible"} {
			t.Run(flag+"/"+status, func(t *testing.T) {
				cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
					t.Fatal("authentication called for invalid status")
					return nil, nil, nil
				})
				var stdout strings.Builder
				cmd.SetOut(&stdout)
				cmd.SetArgs([]string{flag, status, "--format", "json"})
				if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "invalid "+flag) {
					t.Fatalf("expected invalid %s error, got %v", flag, err)
				}
				if stdout.Len() != 0 {
					t.Fatalf("stdout = %q, want empty", stdout.String())
				}
			})
		}
	}
}

func TestCheckVisibilityConflictingStatusFilters(t *testing.T) {
	for _, args := range [][]string{
		{"--status", "visible", "--exclude-status", "visible"},
		{"--exclude-status", "undetermined", "--status", "visible", "--status", "undetermined"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
				t.Fatal("authentication called for conflicting statuses")
				return nil, nil, nil
			})
			var stdout strings.Builder
			cmd.SetOut(&stdout)
			cmd.SetArgs(append(args, "--attendee", "alice@example.com", "--format", "json"))
			if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "both --status and --exclude-status") {
				t.Fatalf("expected conflicting status error, got %v", err)
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q, want empty", stdout.String())
			}
		})
	}
}

func TestCheckVisibilityFilterNoMatchesSucceeds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"accessRole":"reader"}`)
	}))
	defer server.Close()
	for _, filter := range [][]string{
		{"--role", "writer"},
		{"--exclude-role", "reader"},
		{"--status", "not_visible"},
		{"--exclude-status", "visible"},
	} {
		t.Run(filter[0], func(t *testing.T) {
			cmd := newCheckVisibilityCmd(func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error) {
				service, err := calendar.New(&http.Client{})
				if err != nil {
					return nil, nil, err
				}
				service.BasePath = server.URL + "/"
				return service, nil, nil
			})
			var stdout strings.Builder
			cmd.SetOut(&stdout)
			cmd.SetArgs(append([]string{"--attendee", "alice@example.com", "--format", "json"}, filter...))

			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			var report visibilityReport
			if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
				t.Fatal(err)
			}
			if report.Visible == nil || report.NotVisible == nil || report.Undetermined == nil || report.UnresolvedGroups == nil ||
				len(report.Visible)+len(report.NotVisible)+len(report.Undetermined)+len(report.UnresolvedGroups) != 0 {
				t.Fatalf("expected empty arrays, got %s", stdout.String())
			}
		})
	}
}
