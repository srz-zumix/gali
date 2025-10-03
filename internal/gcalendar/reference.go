package gcalendar

import (
	"log"
	"maps"
	"slices"

	"google.golang.org/api/calendar/v3"
)

func GetReferenceMappedEvents(srv *calendar.Service, since, until string, refIDs []string, refMyCals bool, building string) (map[string]*calendar.Event, error) {
	refEventMap := map[string]*calendar.Event{}
	ids := GetReferenceCalendarIDs(srv, refIDs, refMyCals, building)
	if len(ids) > 0 {
		var err error
		refEventMap, err = GetUnionMappedEvents(srv, ids, since, until)
		if err != nil {
			log.Fatalf("Unable to retrieve events from ref calendars: %v", err)
		}
	}
	return refEventMap, nil
}

func GetReferenceCalendarIDs(srv *calendar.Service, refIDs []string, refMyCals bool, building string) []string {
	m := make(map[string]struct{})
	for _, id := range refIDs {
		m[id] = struct{}{}
	}
	if _, ok := m["primary"]; !ok {
		m["primary"] = struct{}{}
	}

	// If ref-mycals is specified, add all my calendars to refIDs
	if refMyCals {
		myCalendarIDs, err := ListCalendarListId(srv)
		if err != nil {
			log.Fatalf("Unable to retrieve my calendar list: %v", err)
		}
		for _, id := range myCalendarIDs {
			m[id] = struct{}{}
		}
	}

	// If building is specified, fetch resource emails and use as refIDs
	if building != "" {
		dsrv, err := GetAdminDirectoryService()
		if err != nil {
			log.Fatalf("Unable to retrieve Admin Directory client: %v", err)
		}
		resources, err := ListAllCalendarResources(dsrv, "my_customer")
		if err != nil {
			log.Fatalf("Unable to list calendar resources: %v", err)
		}
		filtered := FilterCalendarResourcesByBuildingId(resources, building)
		for _, r := range filtered {
			if r.ResourceEmail != "" {
				m[r.ResourceEmail] = struct{}{}
			}
		}
	}
	return slices.Collect(maps.Keys(m))
}
