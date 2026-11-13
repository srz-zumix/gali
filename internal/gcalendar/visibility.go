package gcalendar

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/cloudidentity/v1"
	"google.golang.org/api/googleapi"
)

type UnresolvedGroup struct {
	Group  string
	Reason string
}

type groupExpansion struct {
	ctx      context.Context
	service  *cloudidentity.Service
	emails   map[string]string
	visited  map[string]bool
	problems []string
}

// GetCalendarAccessRole retrieves only the effective role for the caller.
func GetCalendarAccessRole(ctx context.Context, service *calendar.Service, calendarID string) (string, error) {
	if service == nil {
		return "", errors.New("calendar service is unavailable")
	}
	events, err := service.Events.List(calendarID).
		Fields("accessRole").
		MaxResults(1).
		Context(ctx).
		Do()
	if err != nil {
		return "", err
	}
	if events == nil {
		return "", errors.New("calendar API returned an empty response")
	}
	return events.AccessRole, nil
}

// ExpandGroups lists direct group memberships recursively, retaining members
// found before a group or page fails.
func ExpandGroups(ctx context.Context, service *cloudidentity.Service, groups []string) ([]string, []UnresolvedGroup) {
	members := make(map[string]string)
	unresolved := make([]UnresolvedGroup, 0)
	seenGroups := make(map[string]bool)

	for _, email := range groups {
		email = strings.TrimSpace(email)
		key := strings.ToLower(email)
		if email == "" || seenGroups[key] {
			continue
		}
		seenGroups[key] = true

		if service == nil {
			unresolved = append(unresolved, UnresolvedGroup{Group: email, Reason: "Cloud Identity service is unavailable"})
			continue
		}
		expansion := &groupExpansion{
			ctx:     ctx,
			service: service,
			emails:  members,
			visited: make(map[string]bool),
		}
		resource, err := service.Groups.Lookup().GroupKeyId(email).Context(ctx).Do()
		if err != nil {
			expansion.problems = append(expansion.problems, fmt.Sprintf("lookup failed: %s", describeGoogleAPIError(err)))
		} else if resource == nil || resource.Name == "" {
			expansion.problems = append(expansion.problems, "lookup returned no group resource name")
		} else {
			expansion.expand(resource.Name)
		}

		if len(expansion.problems) > 0 {
			sort.Strings(expansion.problems)
			unresolved = append(unresolved, UnresolvedGroup{
				Group:  email,
				Reason: strings.Join(uniqueStrings(expansion.problems), "; "),
			})
		}
	}

	emails := make([]string, 0, len(members))
	for _, email := range members {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	sort.Slice(unresolved, func(i, j int) bool {
		return strings.ToLower(unresolved[i].Group) < strings.ToLower(unresolved[j].Group)
	})
	return emails, unresolved
}

func (e *groupExpansion) expand(resourceName string) {
	if e.visited[resourceName] {
		return
	}
	e.visited[resourceName] = true

	group, err := e.service.Groups.Get(resourceName).
		Fields("dynamicGroupMetadata.status").
		Context(e.ctx).
		Do()
	if err != nil {
		e.problems = append(e.problems, fmt.Sprintf("unable to read group %s: %s", resourceName, describeGoogleAPIError(err)))
	} else if group == nil {
		e.problems = append(e.problems, fmt.Sprintf("unable to read group %s: empty response", resourceName))
	} else if group.DynamicGroupMetadata != nil {
		status := group.DynamicGroupMetadata.Status
		if status == nil {
			e.problems = append(e.problems, fmt.Sprintf("dynamic group %s has no membership status", resourceName))
		} else if status.Status != "UP_TO_DATE" {
			e.problems = append(e.problems, fmt.Sprintf("dynamic group %s membership status is %s", resourceName, status.Status))
		}
	}

	pageToken := ""
	seenTokens := make(map[string]bool)
	for {
		call := e.service.Groups.Memberships.List(resourceName).
			View("FULL").
			PageSize(500).
			Context(e.ctx)
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		page, err := call.Do()
		if err != nil {
			e.problems = append(e.problems, fmt.Sprintf("unable to list memberships for %s: %s", resourceName, describeGoogleAPIError(err)))
			return
		}
		if page == nil {
			e.problems = append(e.problems, fmt.Sprintf("membership listing for %s returned an empty response", resourceName))
			return
		}
		for _, membership := range page.Memberships {
			e.addMembership(resourceName, membership)
		}
		if page.NextPageToken == "" {
			return
		}
		if seenTokens[page.NextPageToken] {
			e.problems = append(e.problems, fmt.Sprintf("membership listing for %s repeated a page token", resourceName))
			return
		}
		seenTokens[page.NextPageToken] = true
		pageToken = page.NextPageToken
	}
}

func (e *groupExpansion) addMembership(parent string, membership *cloudidentity.Membership) {
	if membership == nil || membership.PreferredMemberKey == nil || membership.PreferredMemberKey.Id == "" {
		e.problems = append(e.problems, fmt.Sprintf("group %s contains a membership without a member key", parent))
		return
	}
	member := membership.PreferredMemberKey
	if member.Namespace != "" {
		e.problems = append(e.problems, fmt.Sprintf("group %s contains an external member %q in namespace %q", parent, member.Id, member.Namespace))
		return
	}

	switch membership.Type {
	case "USER":
		email := strings.TrimSpace(member.Id)
		if email == "" || !strings.Contains(email, "@") {
			e.problems = append(e.problems, fmt.Sprintf("group %s contains a user without a usable email address", parent))
			return
		}
		key := strings.ToLower(email)
		if _, ok := e.emails[key]; !ok {
			e.emails[key] = email
		}
	case "GROUP":
		lookup, err := e.service.Groups.Lookup().GroupKeyId(member.Id).Context(e.ctx).Do()
		if err != nil {
			e.problems = append(e.problems, fmt.Sprintf("unable to resolve nested group %q in %s: %s", member.Id, parent, describeGoogleAPIError(err)))
			return
		}
		if lookup == nil || lookup.Name == "" {
			e.problems = append(e.problems, fmt.Sprintf("nested group %q in %s has no resource name", member.Id, parent))
			return
		}
		e.expand(lookup.Name)
	default:
		e.problems = append(e.problems, fmt.Sprintf("group %s contains unsupported member type %q for %q", parent, membership.Type, member.Id))
	}
}

func describeGoogleAPIError(err error) string {
	var apiErr *googleapi.Error
	if errors.As(err, &apiErr) {
		if apiErr.Message != "" {
			return fmt.Sprintf("Google API error (%d): %s", apiErr.Code, apiErr.Message)
		}
		return fmt.Sprintf("Google API error (%d)", apiErr.Code)
	}
	return err.Error()
}

func uniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1] != value {
			result = append(result, value)
		}
	}
	return result
}
