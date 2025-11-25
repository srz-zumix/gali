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

// GetUnionMappedEvents gets a map of event ID to event from reference calendar IDs
func GetUnionMappedEvents(srv *calendar.Service, calendarIDs []string, since, until string) (map[string]*calendar.Event, error) {
	unionEvents := map[string]*calendar.Event{}
	for _, id := range calendarIDs {
		refEvents, err := ListEvents(srv, id, since, until)
		if err == nil {
			for _, item := range refEvents.Items {
				if current, ok := unionEvents[item.Id]; !ok {
					unionEvents[item.Id] = item
				} else {
					if current.Summary == "" && item.Summary != "" {
						unionEvents[item.Id] = item
					}
				}
			}
		}
	}
	return unionEvents, nil
}

// CompletePrivateEvents replaces private events in mainEvents with ref events if available
func CompletePrivateEvents(mainEvents *calendar.Events, refEventMap map[string]*calendar.Event) {
	for i, item := range mainEvents.Items {
		if item.Visibility == "private" && item.Summary == "" {
			if ref, ok := refEventMap[item.Id]; ok {
				if ref.Attendees != nil {
					for _, attendee := range ref.Attendees {
						if attendee.Self {
							attendee.Self = false
						} else {
							if attendee.Email == mainEvents.Summary {
								attendee.Self = true
							}
						}
					}
				}
				if ref.Summary != "" {
					mainEvents.Items[i] = ref
				}
			}
		}
	}
}

func GetSelfResponseStatus(event *calendar.Event) string {
	if event.Attendees != nil {
		for _, attendee := range event.Attendees {
			if attendee.Self && attendee.ResponseStatus != "" {
				return attendee.ResponseStatus
			}
		}
	}
	return ""
}
