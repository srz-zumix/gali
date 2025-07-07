package gcalendar

import (
	admdir "google.golang.org/api/admin/directory/v1"
)

// ListAllCalendarResourcesWithPagination fetches all calendar resources with pagination
func ListAllCalendarResources(srv *admdir.Service, customer string) ([]*admdir.CalendarResource, error) {
	var all []*admdir.CalendarResource
	pageToken := ""
	for {
		call := srv.Resources.Calendars.List(customer)
		if pageToken != "" {
			call.PageToken(pageToken)
		}
		resp, err := call.Do()
		if err != nil {
			return nil, err
		}
		all = append(all, resp.Items...)
		if resp.NextPageToken == "" {
			break
		}
		pageToken = resp.NextPageToken
	}
	return all, nil
}

// FilterCalendarResourcesByBuildingId filters calendar resources by buildingId
func FilterCalendarResourcesByBuildingId(resources []*admdir.CalendarResource, buildingId string) []*admdir.CalendarResource {
	if buildingId == "" {
		return resources
	}
	filtered := make([]*admdir.CalendarResource, 0)
	for _, entry := range resources {
		if entry.BuildingId == buildingId {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}
