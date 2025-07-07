package gcalendar

import (
	"google.golang.org/api/calendar/v3"
)

// ListEvents lists events from the specified calendarID between since and until (inclusive)
func ListEvents(srv *calendar.Service, calendarID, since, until string) (*calendar.Events, error) {
	call := srv.Events.List(calendarID).ShowDeleted(false).SingleEvents(true).OrderBy("startTime").MaxResults(100)
	if since != "" {
		call = call.TimeMin(since)
	}
	if until != "" {
		call = call.TimeMax(until)
	}
	return call.Do()
}

// GetRefEventMap gets a map of event ID to event from reference calendar IDs
func GetRefEventMap(srv *calendar.Service, refIDs []string, since, until string) (map[string]*calendar.Event, error) {
	refEventMap := map[string]*calendar.Event{}
	for _, refID := range refIDs {
		refEvents, err := ListEvents(srv, refID, since, until)
		if err == nil {
			for _, item := range refEvents.Items {
				refEventMap[item.Id] = item
			}
		}
	}
	return refEventMap, nil
}

// CompletePrivateEvents replaces private events in mainEvents with ref events if available
func CompletePrivateEvents(mainEvents *calendar.Events, refEventMap map[string]*calendar.Event) {
	for i, item := range mainEvents.Items {
		if item.Visibility == "private" {
			if ref, ok := refEventMap[item.Id]; ok {
				mainEvents.Items[i] = ref
			}
		}
	}
}
