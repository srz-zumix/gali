package tui

import (
	"testing"
	"time"

	"google.golang.org/api/calendar/v3"
)

func TestGetEventSlots(t *testing.T) {
	loc := time.FixedZone("JST", 9*60*60)
	ev := func(start, end string) *calendar.Event {
		return &calendar.Event{
			Start: &calendar.EventDateTime{DateTime: start},
			End:   &calendar.EventDateTime{DateTime: end},
		}
	}

	cases := []struct {
		name               string
		event              *calendar.Event
		wantStart, wantEnd int
	}{
		{
			name:      "same day 10:00-11:30",
			event:     ev("2026-01-05T10:00:00+09:00", "2026-01-05T11:30:00+09:00"),
			wantStart: 20, wantEnd: 23,
		},
		{
			name:      "overnight 22:00-01:00 fills to end of day",
			event:     ev("2026-01-05T22:00:00+09:00", "2026-01-06T01:00:00+09:00"),
			wantStart: 44, wantEnd: 48,
		},
		{
			name:      "rounds up 09:10-09:50",
			event:     ev("2026-01-05T09:10:00+09:00", "2026-01-05T09:50:00+09:00"),
			wantStart: 18, wantEnd: 20,
		},
	}
	for _, c := range cases {
		start, end := getEventSlots(c.event, loc)
		if start != c.wantStart || end != c.wantEnd {
			t.Errorf("%s: getEventSlots = (%d, %d), want (%d, %d)", c.name, start, end, c.wantStart, c.wantEnd)
		}
	}
}
