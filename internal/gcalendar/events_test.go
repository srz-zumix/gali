package gcalendar

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"
)

func mockCalendarService(t *testing.T, responses map[string]any) *calendar.Service {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response, ok := responses[r.URL.Path]
		if !ok {
			t.Errorf("unexpected request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(response); err != nil {
			t.Errorf("encoding mock response: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	srv, err := calendar.NewService(context.Background(), option.WithEndpoint(server.URL+"/"), option.WithoutAuthentication())
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func TestGetUnionMappedEventsSource(t *testing.T) {
	srv := mockCalendarService(t, map[string]any{
		"/calendars/masked/events": &calendar.Events{Summary: "Masked calendar", Items: []*calendar.Event{
			{Id: "meeting"}, {Id: "masked"},
		}},
		"/calendars/readable/events": &calendar.Events{Summary: "Readable calendar", Items: []*calendar.Event{
			{Id: "meeting", Summary: "Readable meeting"},
		}},
		"/calendars/later/events": &calendar.Events{Summary: "Later calendar", Items: []*calendar.Event{
			{Id: "meeting", Summary: "Later meeting"}, {Id: "masked"},
		}},
	})
	refs, err := GetUnionMappedEvents(srv, []string{"masked", "readable", "later"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if refs["meeting"].CalendarID != "readable" || refs["meeting"].CalendarName != "Readable calendar" ||
		refs["meeting"].Event.Summary != "Readable meeting" {
		t.Fatalf("wrong readable reference: %+v", refs["meeting"])
	}
	if refs["masked"].CalendarID != "masked" {
		t.Fatalf("masked reference overwritten: %+v", refs["masked"])
	}
}

func TestReferencePrimarySource(t *testing.T) {
	srv := mockCalendarService(t, map[string]any{
		"/calendars/primary": &calendar.Calendar{Id: "owner@example.com", Summary: "Owner's calendar"},
		"/calendars/primary/events": &calendar.Events{Items: []*calendar.Event{
			{Id: "meeting", Summary: "Meeting"},
		}},
	})
	for _, alias := range []string{"primary", "me", "@me"} {
		t.Run(alias, func(t *testing.T) {
			refs, err := GetUnionMappedEvents(srv, []string{alias}, "", "")
			if err != nil {
				t.Fatal(err)
			}
			if refs["meeting"].CalendarID != "owner@example.com" || refs["meeting"].CalendarName != "Owner's calendar" {
				t.Fatalf("source is not the actual calendar ID: %+v", refs["meeting"])
			}
		})
	}
}

func TestReferencePrimaryMissingID(t *testing.T) {
	srv := mockCalendarService(t, map[string]any{
		"/calendars/primary": &calendar.Calendar{Summary: "Owner's calendar"},
	})
	// Reference calendars are best-effort: an unusable primary is skipped, not
	// turned into an error that would abort the target calendar reads.
	refs, err := GetReferenceMappedEvents(srv, "", "", nil, false, "")
	if err != nil {
		t.Fatalf("missing primary calendar ID must be skipped, not reported: %v", err)
	}
	if len(refs) != 0 {
		t.Fatalf("no references are available: %+v", refs)
	}
}

func TestCompletePrivateEvents(t *testing.T) {
	for _, tc := range []struct {
		name, visibility, summary, refSummary string
		found, completed                      bool
	}{
		{"masked private", "private", "", "Meeting", true, true},
		{"already readable private", "private", "Original", "Meeting", true, false},
		{"public", "public", "", "Meeting", true, false},
		{"default visibility", "default", "", "Meeting", true, false},
		{"missing reference", "private", "", "Meeting", false, false},
		{"masked reference", "private", "", "", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := &calendar.Event{Id: "event", Visibility: tc.visibility, Summary: tc.summary}
			ref := &calendar.Event{Id: "event", Summary: tc.refSummary}
			refs := map[string]ReferenceEvent{}
			if tc.found {
				refs["event"] = ReferenceEvent{Event: ref, CalendarID: "source@example.com"}
			}
			events := &calendar.Events{Items: []*calendar.Event{original}}
			CompletePrivateEvents(events, refs)
			got := events.Items[0]
			if !tc.completed {
				if got != original || GetCompletionSourceCalendarID(got) != "" {
					t.Fatal("uncompleted event was changed or marked")
				}
				return
			}
			if got == original || got == ref || got.Summary != tc.refSummary {
				t.Fatal("completion must create an independent copy")
			}
			if GetCompletionSourceCalendarID(got) != "source@example.com" {
				t.Fatal("missing completion source")
			}
			if GetCompletionSourceCalendarID(ref) != "" {
				t.Fatal("reference was marked")
			}
			output, err := json.Marshal(events)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(output), `"private":{"gali.completedFrom":"source@example.com"}`) {
				t.Fatalf("JSON lacks provenance: %s", output)
			}
		})
	}
}

func TestCompletionCalendarNames(t *testing.T) {
	for _, name := range []string{"Room One", ""} {
		t.Run(name, func(t *testing.T) {
			ref := &calendar.Event{
				Id: "event", Summary: "Meeting",
				ExtendedProperties: &calendar.EventExtendedProperties{
					Private: map[string]string{CompletedFromNameProperty: "Stale name"},
				},
			}
			events := &calendar.Events{Items: []*calendar.Event{{Id: "event", Visibility: "private"}}}
			CompletePrivateEvents(events, map[string]ReferenceEvent{
				"event": {Event: ref, CalendarID: "source@example.com", CalendarName: name},
			})
			completed := events.Items[0]
			if GetCompletionSourceCalendarName(completed) != name || GetCompletionSourceCalendarID(completed) != "source@example.com" {
				t.Fatal("completion must retain the chosen calendar name and ID")
			}
			label := name
			if label == "" {
				label = "source@example.com"
			}
			if GetCompletionSourceCalendarLabel(completed) != label {
				t.Fatal("name must be preferred, with an ID fallback")
			}
			if GetCompletionSourceCalendarName(ref) != "Stale name" {
				t.Fatal("reference name was mutated")
			}
			output, err := json.Marshal(completed)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(output), `"gali.completedFromName"`) != (name != "") {
				t.Fatalf("incorrect name metadata: %s", output)
			}
		})
	}
}

func TestCompletionCopiesAttendeesAndProperties(t *testing.T) {
	ref := &calendar.Event{
		Id: "event", Summary: "Meeting",
		Attendees: []*calendar.EventAttendee{
			{Email: "viewer@example.com", Self: true, ResponseStatus: "accepted"},
			{Email: "alice@example.com", ResponseStatus: "accepted"},
			{Email: "bob@example.com", ResponseStatus: "tentative"},
		},
		ExtendedProperties: &calendar.EventExtendedProperties{
			Private: map[string]string{"custom": "private"},
			Shared:  map[string]string{"custom": "shared"},
		},
	}
	before, err := json.Marshal(ref)
	if err != nil {
		t.Fatal(err)
	}
	refs := map[string]ReferenceEvent{"event": {Event: ref, CalendarID: "viewer@example.com"}}
	alice := &calendar.Events{
		Summary: "Alice's calendar",
		Items: []*calendar.Event{{
			Id: "event", Visibility: "private",
			Attendees: []*calendar.EventAttendee{{Email: "alice@example.com", Self: true, ResponseStatus: "declined"}},
		}},
	}
	bob := &calendar.Events{
		Summary: "bob@example.com",
		Items:   []*calendar.Event{{Id: "event", Visibility: "private"}},
	}
	CompletePrivateEvents(alice, refs)
	CompletePrivateEvents(bob, refs)
	if GetSelfResponseStatus(alice.Items[0]) != "declined" || GetSelfResponseStatus(bob.Items[0]) != "tentative" {
		t.Fatal("completion mixed the calendar owners' response statuses")
	}
	if alice.Items[0].ExtendedProperties.Private["custom"] != "private" ||
		alice.Items[0].ExtendedProperties.Shared["custom"] != "shared" {
		t.Fatal("existing extended properties were lost")
	}
	alice.Items[0].Attendees[2].Self = true
	alice.Items[0].Attendees[2].ResponseStatus = "declined"
	alice.Items[0].ExtendedProperties.Private["custom"] = "changed"
	alice.Items[0].ExtendedProperties.Shared["custom"] = "changed"
	after, err := json.Marshal(ref)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("completion mutated the reference event")
	}
	if GetSelfResponseStatus(bob.Items[0]) != "tentative" ||
		bob.Items[0].ExtendedProperties.Private["custom"] != "private" ||
		bob.Items[0].ExtendedProperties.Shared["custom"] != "shared" {
		t.Fatal("completed calendars share mutable data")
	}
}
