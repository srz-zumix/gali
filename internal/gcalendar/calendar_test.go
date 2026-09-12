package gcalendar

import (
	"testing"

	"google.golang.org/api/calendar/v3"
)

func TestMapEventsByID(t *testing.T) {
	accepted := &calendar.Event{
		Id:        "accepted",
		Attendees: []*calendar.EventAttendee{{Self: true, ResponseStatus: "accepted"}},
	}
	declined := &calendar.Event{
		Id:        "declined",
		Attendees: []*calendar.EventAttendee{{Self: true, ResponseStatus: "declined"}},
	}
	items := []*calendar.Event{accepted, declined}

	t.Run("showDeclined=false drops declined", func(t *testing.T) {
		m := mapEventsByID(items, false)
		if _, ok := m["accepted"]; !ok {
			t.Errorf("accepted event should be present")
		}
		if _, ok := m["declined"]; ok {
			t.Errorf("declined event should be dropped when showDeclined=false")
		}
	})

	t.Run("showDeclined=true keeps declined", func(t *testing.T) {
		m := mapEventsByID(items, true)
		if _, ok := m["accepted"]; !ok {
			t.Errorf("accepted event should be present")
		}
		if _, ok := m["declined"]; !ok {
			t.Errorf("declined event should be present when showDeclined=true")
		}
	})
}
