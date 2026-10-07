package gcalendar

import (
	"maps"

	"google.golang.org/api/calendar/v3"
)

const (
	CompletedFromProperty     = "gali.completedFrom"
	CompletedFromNameProperty = "gali.completedFromName"
)

type ReferenceEvent struct {
	Event        *calendar.Event
	CalendarID   string
	CalendarName string
}

// ListEvents lists events from the specified calendarID between since and until (inclusive)
func ListEvents(srv *calendar.Service, calendarID, since, until string) (*calendar.Events, error) {
	id := ResolveCalendarIDAlias(srv, calendarID)
	call := srv.Events.List(id).ShowDeleted(false).SingleEvents(true).OrderBy("startTime").MaxResults(1000)
	if since != "" {
		call = call.TimeMin(since)
	}
	if until != "" {
		call = call.TimeMax(until)
	}
	return call.Do()
}

// GetUnionMappedEvents keeps the first readable copy and its source calendar.
func GetUnionMappedEvents(srv *calendar.Service, calendarIDs []string, since, until string) (map[string]ReferenceEvent, error) {
	unionEvents := map[string]ReferenceEvent{}
	for _, id := range calendarIDs {
		sourceID := ResolveCalendarIDAlias(srv, id)
		sourceName := ""
		if sourceID == "primary" {
			// Reference calendars are best-effort: "primary" is always in the
			// list even for a credential that has no primary calendar, so a
			// failure here must skip this reference rather than abort reads of
			// the target calendars.
			source, err := srv.Calendars.Get(sourceID).Do()
			if err != nil || source.Id == "" {
				continue
			}
			sourceID = source.Id
			sourceName = source.Summary
		}
		refEvents, err := ListEvents(srv, id, since, until)
		if err == nil {
			if refEvents.Summary != "" {
				sourceName = refEvents.Summary
			}
			for _, item := range refEvents.Items {
				if current, ok := unionEvents[item.Id]; !ok {
					unionEvents[item.Id] = ReferenceEvent{Event: item, CalendarID: sourceID, CalendarName: sourceName}
				} else {
					if current.Event.Summary == "" && item.Summary != "" {
						unionEvents[item.Id] = ReferenceEvent{Event: item, CalendarID: sourceID, CalendarName: sourceName}
					}
				}
			}
		}
	}
	return unionEvents, nil
}

// CompletePrivateEvents copies readable references and records their source in output-only metadata.
func CompletePrivateEvents(mainEvents *calendar.Events, refEventMap map[string]ReferenceEvent) {
	for i, item := range mainEvents.Items {
		if item.Visibility == "private" && item.Summary == "" {
			if ref, ok := refEventMap[item.Id]; ok && ref.Event.Summary != "" {
				completed := *ref.Event
				ownerEmail := mainEvents.Summary
				ownerResponse := GetSelfResponseStatus(item)
				for _, attendee := range item.Attendees {
					if attendee.Self {
						ownerEmail = attendee.Email
						break
					}
				}
				completed.Attendees = make([]*calendar.EventAttendee, len(ref.Event.Attendees))
				for j, attendee := range ref.Event.Attendees {
					copy := *attendee
					copy.Self = copy.Email == ownerEmail
					if copy.Self && ownerResponse != "" {
						copy.ResponseStatus = ownerResponse
					}
					completed.Attendees[j] = &copy
				}
				properties := calendar.EventExtendedProperties{}
				if ref.Event.ExtendedProperties != nil {
					properties = *ref.Event.ExtendedProperties
					properties.Private = maps.Clone(properties.Private)
					properties.Shared = maps.Clone(properties.Shared)
				}
				if properties.Private == nil {
					properties.Private = map[string]string{}
				}
				properties.Private[CompletedFromProperty] = ref.CalendarID
				if ref.CalendarName != "" {
					properties.Private[CompletedFromNameProperty] = ref.CalendarName
				} else {
					delete(properties.Private, CompletedFromNameProperty)
				}
				completed.ExtendedProperties = &properties
				mainEvents.Items[i] = &completed
			}
		}
	}
}

func GetCompletionSourceCalendarID(event *calendar.Event) string {
	if event.ExtendedProperties == nil {
		return ""
	}
	return event.ExtendedProperties.Private[CompletedFromProperty]
}

func GetCompletionSourceCalendarName(event *calendar.Event) string {
	if event.ExtendedProperties == nil {
		return ""
	}
	return event.ExtendedProperties.Private[CompletedFromNameProperty]
}

func GetCompletionSourceCalendarLabel(event *calendar.Event) string {
	if name := GetCompletionSourceCalendarName(event); name != "" {
		return name
	}
	return GetCompletionSourceCalendarID(event)
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

func FindAttendeeByEmail(event *calendar.Event, email string) *calendar.EventAttendee {
	if event.Attendees != nil {
		for _, attendee := range event.Attendees {
			if attendee.Email == email {
				return attendee
			}
		}
	}
	return nil
}
