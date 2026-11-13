package gcalendar

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/cloudidentity/v1"
	"google.golang.org/api/option"
)

func TestGetCalendarAccessRoleOnlyRequestsRole(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Query().Get("fields") != "accessRole" {
			t.Errorf("fields = %q, want accessRole", r.URL.Query().Get("fields"))
		}
		if r.URL.Query().Get("maxResults") != "1" {
			t.Errorf("maxResults = %q, want 1", r.URL.Query().Get("maxResults"))
		}
		_, _ = fmt.Fprint(w, `{"accessRole":"reader","items":[]}`)
	}))
	defer server.Close()

	service, err := calendar.NewService(context.Background(), option.WithHTTPClient(&http.Client{}))
	if err != nil {
		t.Fatal(err)
	}
	service.BasePath = server.URL + "/"
	role, err := GetCalendarAccessRole(context.Background(), service, "alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if role != "reader" {
		t.Fatalf("role = %q, want reader", role)
	}
}

func TestVisibilityAuthProfilesKeepSeparateTokenCaches(t *testing.T) {
	individualScopes, individualCache := visibilityAuthProfile(false)
	groupScopes, groupCache := visibilityAuthProfile(true)

	if individualCache != defaultTokenCacheFile {
		t.Fatalf("individual token cache = %q, want %q", individualCache, defaultTokenCacheFile)
	}
	if groupCache != visibilityGroupsTokenCacheFile || groupCache == individualCache {
		t.Fatalf("group token cache = %q, want separate %q", groupCache, visibilityGroupsTokenCacheFile)
	}
	if strings.Join(individualScopes, ",") != strings.Join(GetGaliScope(), ",") {
		t.Fatalf("individual scopes = %v, want existing scopes %v", individualScopes, GetGaliScope())
	}
	if len(groupScopes) != 2 || groupScopes[0] != calendar.CalendarReadonlyScope || groupScopes[1] != cloudidentity.CloudIdentityGroupsReadonlyScope {
		t.Fatalf("group scopes = %v, want Calendar and Cloud Identity read-only scopes", groupScopes)
	}
}

func TestNewVisibilityServicesRejectsMissingClient(t *testing.T) {
	if _, _, err := newVisibilityServices(context.Background(), nil, true); err == nil {
		t.Fatal("newVisibilityServices() error = nil, want missing-client error")
	}
}

func TestExpandGroupsPaginatesNestedGroupsAndDeduplicates(t *testing.T) {
	var rootPages int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/groups:lookup":
			switch r.URL.Query().Get("groupKey.id") {
			case "team@example.com":
				_, _ = fmt.Fprint(w, `{"name":"groups/root"}`)
			case "nested@example.com":
				_, _ = fmt.Fprint(w, `{"name":"groups/nested"}`)
			default:
				t.Errorf("unexpected Cloud Identity request: %s %s", r.Method, r.URL.String())
				http.NotFound(w, r)
			}
		case "/v1/groups/root":
			if r.URL.Query().Get("fields") != "dynamicGroupMetadata.status" {
				t.Errorf("group fields = %q, want dynamicGroupMetadata.status", r.URL.Query().Get("fields"))
			}
			_, _ = fmt.Fprint(w, `{"name":"groups/root"}`)
		case "/v1/groups/nested":
			_, _ = fmt.Fprint(w, `{"name":"groups/nested"}`)
		case "/v1/groups/root/memberships":
			if r.URL.Query().Get("view") != "FULL" {
				t.Errorf("view = %q, want FULL", r.URL.Query().Get("view"))
			}
			if r.URL.Query().Get("pageSize") != "500" {
				t.Errorf("pageSize = %q, want 500", r.URL.Query().Get("pageSize"))
			}
			switch r.URL.Query().Get("pageToken") {
			case "":
				rootPages++
				_, _ = fmt.Fprint(w, `{"memberships":[
					{"type":"USER","preferredMemberKey":{"id":"alice@example.com"}},
					{"type":"GROUP","preferredMemberKey":{"id":"nested@example.com"}}
				],"nextPageToken":"next"}`)
			case "next":
				rootPages++
				_, _ = fmt.Fprint(w, `{"memberships":[
					{"type":"USER","preferredMemberKey":{"id":"alice@example.com"}}
				]}`)
			default:
				http.Error(w, "unexpected page token", http.StatusBadRequest)
			}
		case "/v1/groups/nested/memberships":
			_, _ = fmt.Fprint(w, `{"memberships":[
				{"type":"USER","preferredMemberKey":{"id":"bob@example.com"}},
				{"type":"GROUP","preferredMemberKey":{"id":"team@example.com"}}
			]}`)
		default:
			t.Errorf("unexpected Cloud Identity request: %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	service, err := cloudidentity.NewService(context.Background(), option.WithHTTPClient(&http.Client{}))
	if err != nil {
		t.Fatal(err)
	}
	service.BasePath = server.URL + "/"
	members, unresolved := ExpandGroups(context.Background(), service, []string{"team@example.com"})
	if len(unresolved) != 0 {
		t.Fatalf("unresolved = %#v, want none", unresolved)
	}
	if want := []string{"alice@example.com", "bob@example.com"}; strings.Join(members, ",") != strings.Join(want, ",") {
		t.Fatalf("members = %v, want %v", members, want)
	}
	if rootPages != 2 {
		t.Fatalf("root membership pages = %d, want 2", rootPages)
	}
}

func TestExpandGroupsKeepsMembersWhenDynamicGroupIsUpdating(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/groups:lookup":
			_, _ = fmt.Fprint(w, `{"name":"groups/dynamic"}`)
		case "/v1/groups/dynamic":
			if r.URL.Query().Get("fields") != "dynamicGroupMetadata.status" {
				t.Errorf("group fields = %q, want dynamicGroupMetadata.status", r.URL.Query().Get("fields"))
			}
			_, _ = fmt.Fprint(w, `{"name":"groups/dynamic","dynamicGroupMetadata":{"status":{"status":"UPDATING_MEMBERSHIPS"}}}`)
		case "/v1/groups/dynamic/memberships":
			_, _ = fmt.Fprint(w, `{"memberships":[
				{"type":"USER","preferredMemberKey":{"id":"alice@example.com"}}
			]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	service, err := cloudidentity.NewService(context.Background(), option.WithHTTPClient(&http.Client{}))
	if err != nil {
		t.Fatal(err)
	}
	service.BasePath = server.URL + "/"
	members, unresolved := ExpandGroups(context.Background(), service, []string{"dynamic@example.com"})
	if want := []string{"alice@example.com"}; strings.Join(members, ",") != strings.Join(want, ",") {
		t.Fatalf("members = %v, want %v", members, want)
	}
	if len(unresolved) != 1 || !strings.Contains(unresolved[0].Reason, "UPDATING_MEMBERSHIPS") {
		t.Fatalf("unresolved = %#v, want updating-memberships issue", unresolved)
	}
}

func TestExpandGroupsKeepsEarlierPagesAfterFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/groups:lookup":
			_, _ = fmt.Fprint(w, `{"name":"groups/partial"}`)
		case r.URL.Path == "/v1/groups/partial":
			_, _ = fmt.Fprint(w, `{"name":"groups/partial"}`)
		case r.URL.Path == "/v1/groups/partial/memberships" && r.URL.Query().Get("pageToken") == "":
			_, _ = fmt.Fprint(w, `{"memberships":[
				{"type":"USER","preferredMemberKey":{"id":"alice@example.com"}}
			],"nextPageToken":"next"}`)
		case r.URL.Path == "/v1/groups/partial/memberships" && r.URL.Query().Get("pageToken") == "next":
			http.Error(w, `{"error":{"code":503,"message":"temporary failure"}}`, http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	service, err := cloudidentity.NewService(context.Background(), option.WithHTTPClient(&http.Client{}))
	if err != nil {
		t.Fatal(err)
	}
	service.BasePath = server.URL + "/"
	members, unresolved := ExpandGroups(context.Background(), service, []string{"partial@example.com"})
	if want := []string{"alice@example.com"}; strings.Join(members, ",") != strings.Join(want, ",") {
		t.Fatalf("members = %v, want %v", members, want)
	}
	if len(unresolved) != 1 || !strings.Contains(unresolved[0].Reason, "503") {
		t.Fatalf("unresolved = %#v, want page failure", unresolved)
	}
}
