package gcalendar

import (
	"fmt"
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

func GetIdMappedEvents(srv *calendar.Service, since, until string, showDeclined bool, calendarIDs ...string) []map[string]*calendar.Event {
	getEvents := func(calID string) map[string]*calendar.Event {
		events, err := ListEvents(srv, calID, since, until)
		if err != nil {
			log.Fatalf("Unable to retrieve events for %s: %v", calID, err)
		}
		return mapEventsByID(events.Items, showDeclined)
	}

	calendars := make([]map[string]*calendar.Event, len(calendarIDs))
	for i, calID := range calendarIDs {
		calendars[i] = getEvents(calID)
	}
	return calendars
}

// mapEventsByID builds an ID→event map, skipping events the user has declined
// unless showDeclined is true.
func mapEventsByID(items []*calendar.Event, showDeclined bool) map[string]*calendar.Event {
	m := make(map[string]*calendar.Event)
	for _, item := range items {
		if !showDeclined && GetSelfResponseStatus(item) == "declined" {
			continue
		}
		m[item.Id] = item
	}
	return m
}

func ResolveCalendarIDAlias(srv *calendar.Service, calendarID string) string {
	if calendarID == "@me" || calendarID == "me" {
		return "primary"
	}
	return calendarID
}

func ResolveCalendarID(srv *calendar.Service, calendarID string) (string, error) {
	id := ResolveCalendarIDAlias(srv, calendarID)
	if id == "primary" {
		userInfo, err := srv.Acl.List("primary").Do()
		if err != nil {
			return "", fmt.Errorf("unable to retrieve primary calendar info: %w", err)
		}
		if len(userInfo.Items) == 0 || userInfo.Items[0].Scope == nil {
			return id, nil
		}
		return userInfo.Items[0].Scope.Value, nil
	}
	return id, nil
}

func ResolveCalendarIDs(srv *calendar.Service, calendarIDs []string) ([]string, error) {
	resolved := make([]string, len(calendarIDs))
	for i, calID := range calendarIDs {
		id, err := ResolveCalendarID(srv, calID)
		if err != nil {
			return nil, err
		}
		resolved[i] = id
	}
	return resolved, nil
}
