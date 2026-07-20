package gcalendar

import (
	"testing"
	"time"

	"google.golang.org/api/calendar/v3"
)

func TestIsIgnorableEvent(t *testing.T) {
	declined := &calendar.Event{
		Attendees: []*calendar.EventAttendee{
			{Self: true, ResponseStatus: "declined"},
		},
	}
	if !IsIgnorableEvent(declined) {
		t.Errorf("expected declined event to be ignorable")
	}

	transparent := &calendar.Event{Transparency: "transparent"}
	if !IsIgnorableEvent(transparent) {
		t.Errorf("expected transparent event to be ignorable")
	}

	busy := &calendar.Event{}
	if IsIgnorableEvent(busy) {
		t.Errorf("expected opaque event to not be ignorable")
	}
}

func TestIsAdjustableEvent(t *testing.T) {
	cases := []struct {
		name string
		e    *calendar.Event
		want bool
	}{
		{"tentative", &calendar.Event{Attendees: []*calendar.EventAttendee{{Self: true, ResponseStatus: "tentative"}}}, true},
		{"needsAction", &calendar.Event{Attendees: []*calendar.EventAttendee{{Self: true, ResponseStatus: "needsAction"}}}, true},
		{"no attendees", &calendar.Event{}, true},
		{"self only", &calendar.Event{Attendees: []*calendar.EventAttendee{{Self: true, ResponseStatus: "accepted"}}}, true},
		{"recurring", &calendar.Event{RecurringEventId: "abc", Attendees: []*calendar.EventAttendee{{Self: true}, {Email: "other@example.com"}}}, true},
		{"self organizer", &calendar.Event{Organizer: &calendar.EventOrganizer{Self: true}, Attendees: []*calendar.EventAttendee{{Self: true}, {Email: "other@example.com"}}}, true},
		{"unresolved private", &calendar.Event{Visibility: "private"}, false},
		{"fixed meeting", &calendar.Event{
			Attendees: []*calendar.EventAttendee{
				{Self: true, ResponseStatus: "accepted"},
				{Email: "other@example.com", ResponseStatus: "accepted"},
			},
			Organizer: &calendar.EventOrganizer{Self: false},
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsAdjustableEvent(c.e); got != c.want {
				t.Errorf("IsAdjustableEvent(%s) = %v, want %v", c.name, got, c.want)
			}
		})
	}
}

func TestComputeCandidates(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}

	// Monday 2026-07-06
	day := time.Date(2026, 7, 6, 0, 0, 0, 0, loc)

	fixedMeeting := &calendar.Event{
		Id:      "fixed",
		Summary: "Fixed Meeting",
		Start:   &calendar.EventDateTime{DateTime: day.Add(10 * time.Hour).Format(time.RFC3339)},
		End:     &calendar.EventDateTime{DateTime: day.Add(11 * time.Hour).Format(time.RFC3339)},
		Attendees: []*calendar.EventAttendee{
			{Self: true, ResponseStatus: "accepted"},
			{Email: "other@example.com", ResponseStatus: "accepted"},
		},
	}
	adjustableMeeting := &calendar.Event{
		Id:      "adjustable",
		Summary: "Tentative 1:1",
		Start:   &calendar.EventDateTime{DateTime: day.Add(14 * time.Hour).Format(time.RFC3339)},
		End:     &calendar.EventDateTime{DateTime: day.Add(15 * time.Hour).Format(time.RFC3339)},
		Attendees: []*calendar.EventAttendee{
			{Self: true, ResponseStatus: "tentative"},
		},
	}

	opts := SlotOptions{
		Since:           day,
		Until:           day.Add(24 * time.Hour),
		Duration:        time.Hour,
		Step:            30 * time.Minute,
		WorkStart:       9 * time.Hour,
		WorkEnd:         18 * time.Hour,
		IncludeWeekends: false,
		Location:        loc,
	}

	candidates := ComputeCandidates(
		[]string{"cal1"},
		[][]*calendar.Event{{fixedMeeting, adjustableMeeting}},
		opts,
	)

	sawBusyOverlap := false
	sawAdjustable := false
	for _, c := range candidates {
		if overlaps(c.Start, c.End, day.Add(10*time.Hour), day.Add(11*time.Hour)) {
			sawBusyOverlap = true
		}
		if overlaps(c.Start, c.End, day.Add(14*time.Hour), day.Add(15*time.Hour)) {
			if c.Status != SlotAdjustable {
				t.Errorf("expected slot overlapping adjustable meeting to be ADJUSTABLE, got %v", c.Status)
			}
			sawAdjustable = true
		}
		if c.Start.Before(opts.Since.Add(opts.WorkStart)) || c.End.After(opts.Since.Add(opts.WorkEnd)) {
			t.Errorf("candidate %v-%v outside work hours", c.Start, c.End)
		}
	}
	if sawBusyOverlap {
		t.Errorf("did not expect any candidate overlapping the fixed meeting")
	}
	if !sawAdjustable {
		t.Errorf("expected at least one ADJUSTABLE candidate overlapping the tentative meeting")
	}
}

func TestComputeCandidatesExcludesWeekends(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	// Saturday 2026-07-11
	saturday := time.Date(2026, 7, 11, 0, 0, 0, 0, loc)

	opts := SlotOptions{
		Since:     saturday,
		Until:     saturday.Add(24 * time.Hour),
		Duration:  time.Hour,
		Step:      30 * time.Minute,
		WorkStart: 9 * time.Hour,
		WorkEnd:   18 * time.Hour,
		Location:  loc,
	}

	candidates := ComputeCandidates([]string{"cal1"}, [][]*calendar.Event{{}}, opts)
	if len(candidates) != 0 {
		t.Errorf("expected no candidates on weekend when IncludeWeekends is false, got %d", len(candidates))
	}

	opts.IncludeWeekends = true
	candidates = ComputeCandidates([]string{"cal1"}, [][]*calendar.Event{{}}, opts)
	if len(candidates) == 0 {
		t.Errorf("expected candidates on weekend when IncludeWeekends is true")
	}
}
