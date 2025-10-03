package gcalendar

import (
	"log"

	"google.golang.org/api/calendar/v3"
)

// ListCalendarList fetches the calendar list using the Calendar API
func ListCalendarList(srv *calendar.Service) (*calendar.CalendarList, error) {
	return srv.CalendarList.List().Do()
}

func ListCalendarListId(srv *calendar.Service) ([]string, error) {
	ids := []string{}
	cl, err := ListCalendarList(srv)
	if err != nil {
		log.Fatalf("Unable to retrieve calendar list: %v", err)
	}
	for _, entry := range cl.Items {
		if entry.Id != "" && entry.Id != "primary" {
			ids = append(ids, entry.Id)
		}
	}
	return ids, nil
}

func GetIdMappedEvents(srv *calendar.Service, since, until string, calendarIDs ...string) []map[string]*calendar.Event {
	getEvents := func(calID string) map[string]*calendar.Event {
		events, err := ListEvents(srv, calID, since, until)
		if err != nil {
			log.Fatalf("Unable to retrieve events for %s: %v", calID, err)
		}
		m := make(map[string]*calendar.Event)
		for _, item := range events.Items {
			if GetSelfResponseStatus(item) == "declined" {
				continue
			}
			m[item.Id] = item
		}
		return m
	}

	calendars := make([]map[string]*calendar.Event, len(calendarIDs))
	for i, calID := range calendarIDs {
		calendars[i] = getEvents(calID)
	}
	return calendars
}
