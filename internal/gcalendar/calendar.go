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
