package tui

import (
	"reflect"
	"sort"
	"testing"
	"time"

	"google.golang.org/api/calendar/v3"
)

func TestGetEventSlots(t *testing.T) {
	loc := time.FixedZone("JST", 9*60*60)
	day := func(s string) time.Time {
		d, err := time.ParseInLocation("2006-01-02", s, loc)
		if err != nil {
			t.Fatalf("bad day %q: %v", s, err)
		}
		return d
	}
	ev := func(start, end string) *calendar.Event {
		return &calendar.Event{
			Start: &calendar.EventDateTime{DateTime: start},
			End:   &calendar.EventDateTime{DateTime: end},
		}
	}

	cases := []struct {
		name               string
		event              *calendar.Event
		day                time.Time
		wantStart, wantEnd int
	}{
		{
			name:      "same day 10:00-11:30",
			event:     ev("2026-01-05T10:00:00+09:00", "2026-01-05T11:30:00+09:00"),
			day:       day("2026-01-05"),
			wantStart: 20, wantEnd: 23,
		},
		{
			name:      "overnight start day fills to end",
			event:     ev("2026-01-05T22:00:00+09:00", "2026-01-06T01:00:00+09:00"),
			day:       day("2026-01-05"),
			wantStart: 44, wantEnd: 48,
		},
		{
			name:      "overnight continuation day starts at 0",
			event:     ev("2026-01-05T22:00:00+09:00", "2026-01-06T01:00:00+09:00"),
			day:       day("2026-01-06"),
			wantStart: 0, wantEnd: 2,
		},
		{
			name:      "multi-day middle day fills whole day",
			event:     ev("2026-01-05T22:00:00+09:00", "2026-01-07T01:00:00+09:00"),
			day:       day("2026-01-06"),
			wantStart: 0, wantEnd: 48,
		},
		{
			name:      "rounds up 09:10-09:50",
			event:     ev("2026-01-05T09:10:00+09:00", "2026-01-05T09:50:00+09:00"),
			day:       day("2026-01-05"),
			wantStart: 18, wantEnd: 20,
		},
	}
	for _, c := range cases {
		start, end := getEventSlots(c.event, loc, c.day)
		if start != c.wantStart || end != c.wantEnd {
			t.Errorf("%s: getEventSlots = (%d, %d), want (%d, %d)", c.name, start, end, c.wantStart, c.wantEnd)
		}
	}
}

func TestEventDayKeys(t *testing.T) {
	loc := time.FixedZone("JST", 9*60*60)

	cases := []struct {
		name  string
		event *calendar.Event
		want  []string
	}{
		{
			name:  "single timed event",
			event: &calendar.Event{Start: &calendar.EventDateTime{DateTime: "2026-01-05T10:00:00+09:00"}, End: &calendar.EventDateTime{DateTime: "2026-01-05T11:00:00+09:00"}},
			want:  []string{"2026-01-05"},
		},
		{
			name:  "timed overnight event spans two days",
			event: &calendar.Event{Start: &calendar.EventDateTime{DateTime: "2026-01-05T22:00:00+09:00"}, End: &calendar.EventDateTime{DateTime: "2026-01-06T01:00:00+09:00"}},
			want:  []string{"2026-01-05", "2026-01-06"},
		},
		{
			name:  "timed event ending exactly at midnight stays one day",
			event: &calendar.Event{Start: &calendar.EventDateTime{DateTime: "2026-01-05T10:00:00+09:00"}, End: &calendar.EventDateTime{DateTime: "2026-01-06T00:00:00+09:00"}},
			want:  []string{"2026-01-05"},
		},
		{
			name:  "single all-day event (exclusive end)",
			event: &calendar.Event{Start: &calendar.EventDateTime{Date: "2026-01-05"}, End: &calendar.EventDateTime{Date: "2026-01-06"}},
			want:  []string{"2026-01-05"},
		},
		{
			name:  "multi-day all-day event Jan5-7 (exclusive end Jan8)",
			event: &calendar.Event{Start: &calendar.EventDateTime{Date: "2026-01-05"}, End: &calendar.EventDateTime{Date: "2026-01-08"}},
			want:  []string{"2026-01-05", "2026-01-06", "2026-01-07"},
		},
	}
	for _, c := range cases {
		got := eventDayKeys(c.event, loc)
		sort.Strings(got)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: eventDayKeys = %v, want %v", c.name, got, c.want)
		}
	}
}
