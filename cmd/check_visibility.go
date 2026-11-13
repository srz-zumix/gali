package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/mail"
	"slices"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/cloudidentity/v1"
)

type visibilityResult struct {
	Email      string `json:"email"`
	AccessRole string `json:"access_role,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type unresolvedGroupResult struct {
	Group  string `json:"group"`
	Reason string `json:"reason"`
}

type visibilityCounts struct {
	Visible          int `json:"visible"`
	NotVisible       int `json:"not_visible"`
	Undetermined     int `json:"undetermined"`
	UnresolvedGroups int `json:"unresolved_groups"`
}

type visibilityReport struct {
	Visible          []visibilityResult      `json:"visible"`
	NotVisible       []visibilityResult      `json:"not_visible"`
	Undetermined     []visibilityResult      `json:"undetermined"`
	UnresolvedGroups []unresolvedGroupResult `json:"unresolved_groups"`
	Counts           visibilityCounts        `json:"counts"`
}

type visibilityServiceGetter func(context.Context, bool, io.Writer) (*calendar.Service, *cloudidentity.Service, error)

func NewCheckVisibilityCmd() *cobra.Command {
	return newCheckVisibilityCmd(gcalendar.GetVisibilityServices)
}

func newCheckVisibilityCmd(getServices visibilityServiceGetter) *cobra.Command {
	var attendees, groups, roles, excludedRoles, statuses, excludedStatuses []string
	var outputFormat string
	roleChoices := []string{"none", "freeBusyReader", "reader", "writerWithoutPrivateAccess", "writer", "owner"}
	statusChoices := []string{"visible", "not_visible", "undetermined", "unresolved_groups"}

	cmd := &cobra.Command{
		Use:   "check-visibility",
		Short: "Check effective access to default-visibility events",
		Long: `Check whether the authenticated user can read default-visibility event details
on the specified calendars. This checks effective access roles only; it does not
inspect event details or determine whether a calendar is publicly shared.`,
		Args:          cobra.NoArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if outputFormat != "" && outputFormat != "json" {
				return fmt.Errorf("unsupported output format %q (expected json or empty)", outputFormat)
			}
			roleFilter, err := parseFilter("--role", roles, roleChoices)
			if err != nil {
				return err
			}
			excludeFilter, err := parseFilter("--exclude-role", excludedRoles, roleChoices)
			if err != nil {
				return err
			}
			for _, role := range excludedRoles {
				if roleFilter[role] {
					return fmt.Errorf("access role %q cannot be specified in both --role and --exclude-role", role)
				}
			}
			includeStatuses, err := parseFilter("--status", statuses, statusChoices)
			if err != nil {
				return err
			}
			excludeStatuses, err := parseFilter("--exclude-status", excludedStatuses, statusChoices)
			if err != nil {
				return err
			}
			for _, status := range excludedStatuses {
				if includeStatuses[status] {
					return fmt.Errorf("result status %q cannot be specified in both --status and --exclude-status", status)
				}
			}
			selectedStatuses := make(map[string]bool, len(statusChoices))
			for _, status := range statusChoices {
				selectedStatuses[status] = (len(includeStatuses) == 0 || includeStatuses[status]) && !excludeStatuses[status]
			}
			attendees, err := normalizeEmails(attendees)
			if err != nil {
				return fmt.Errorf("invalid --attendee: %w", err)
			}
			groups, err := normalizeEmails(groups)
			if err != nil {
				return fmt.Errorf("invalid --group: %w", err)
			}

			report := emptyVisibilityReport()
			if len(attendees) == 0 && len(groups) == 0 {
				return writeVisibilityReport(cmd.OutOrStdout(), outputFormat, report, selectedStatuses)
			}

			if len(groups) > 0 {
				if _, err := fmt.Fprintln(cmd.ErrOrStderr(), "Note: group checks use a separate OAuth token and may authenticate as a different Google account than individual-only checks."); err != nil {
					return fmt.Errorf("unable to write authentication note: %w", err)
				}
			}
			calendarService, groupService, serviceErr := getServices(cmd.Context(), len(groups) > 0, cmd.ErrOrStderr())
			if serviceErr != nil {
				for _, email := range attendees {
					report.Undetermined = append(report.Undetermined, visibilityResult{Email: email, Reason: serviceErr.Error()})
				}
				for _, group := range groups {
					report.UnresolvedGroups = append(report.UnresolvedGroups, unresolvedGroupResult{Group: group, Reason: serviceErr.Error()})
				}
			} else {
				if len(groups) > 0 {
					members, unresolved := gcalendar.ExpandGroups(cmd.Context(), groupService, groups)
					for _, issue := range unresolved {
						report.UnresolvedGroups = append(report.UnresolvedGroups, unresolvedGroupResult{Group: issue.Group, Reason: issue.Reason})
					}
					attendees = append(attendees, members...)
				}
				attendees = uniqueEmails(attendees)
				for _, email := range attendees {
					role, err := gcalendar.GetCalendarAccessRole(cmd.Context(), calendarService, email)
					if err != nil {
						report.Undetermined = append(report.Undetermined, visibilityResult{
							Email:  email,
							Reason: err.Error(),
						})
						continue
					}
					result := visibilityResult{Email: email, AccessRole: role}
					matchesFilter := (len(roleFilter) == 0 || roleFilter[role]) && !excludeFilter[role]
					switch role {
					case "reader", "writerWithoutPrivateAccess", "writer", "owner":
						if matchesFilter {
							report.Visible = append(report.Visible, result)
						}
					case "freeBusyReader", "none":
						if matchesFilter {
							report.NotVisible = append(report.NotVisible, result)
						}
					default:
						result.Reason = fmt.Sprintf("unknown or missing access role %q", role)
						report.Undetermined = append(report.Undetermined, result)
					}
				}
			}

			sortVisibilityReport(&report)
			if err := writeVisibilityReport(cmd.OutOrStdout(), outputFormat, report, selectedStatuses); err != nil {
				return err
			}
			if len(report.Undetermined) > 0 || len(report.UnresolvedGroups) > 0 {
				return fmt.Errorf("visibility check incomplete: %d undetermined calendars and %d unresolved groups", len(report.Undetermined), len(report.UnresolvedGroups))
			}
			return nil
		},
	}
	cmd.Flags().StringArrayVar(&attendees, "attendee", nil, "Calendar email address to check (repeatable)")
	cmd.Flags().StringArrayVar(&groups, "group", nil, "Google Workspace group to expand and check (repeatable)")
	cmd.Flags().StringArrayVar(&roles, "role", nil, "Filter by access role: none, freeBusyReader, reader, writerWithoutPrivateAccess, writer, owner (repeatable)")
	cmd.Flags().StringArrayVar(&excludedRoles, "exclude-role", nil, "Exclude access roles from results (repeatable)")
	cmd.Flags().StringArrayVar(&statuses, "status", nil, "Filter by result status: visible, not_visible, undetermined, unresolved_groups (repeatable)")
	cmd.Flags().StringArrayVar(&excludedStatuses, "exclude-status", nil, "Exclude result statuses (repeatable)")
	cmd.Flags().StringVar(&outputFormat, "format", "", "Output format (json or empty for text)")
	return cmd
}

func parseFilter(flag string, values, choices []string) (map[string]bool, error) {
	filter := make(map[string]bool, len(values))
	for _, value := range values {
		if !slices.Contains(choices, value) {
			return nil, fmt.Errorf("invalid %s %q (expected %s, or %s)", flag, value, strings.Join(choices[:len(choices)-1], ", "), choices[len(choices)-1])
		}
		filter[value] = true
	}
	return filter, nil
}

func emptyVisibilityReport() visibilityReport {
	return visibilityReport{
		Visible:          []visibilityResult{},
		NotVisible:       []visibilityResult{},
		Undetermined:     []visibilityResult{},
		UnresolvedGroups: []unresolvedGroupResult{},
	}
}

func normalizeEmails(values []string) ([]string, error) {
	emails := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		parsed, err := mail.ParseAddress(value)
		if err != nil || parsed.Address != value || !strings.Contains(value, "@") {
			return nil, fmt.Errorf("%q is not a valid email address", value)
		}
		emails = append(emails, strings.ToLower(value))
	}
	return uniqueEmails(emails), nil
}

func uniqueEmails(emails []string) []string {
	seen := make(map[string]bool, len(emails))
	result := make([]string, 0, len(emails))
	for _, email := range emails {
		key := strings.ToLower(email)
		if !seen[key] {
			seen[key] = true
			result = append(result, email)
		}
	}
	sort.Strings(result)
	return result
}

func sortVisibilityReport(report *visibilityReport) {
	sort.Slice(report.Visible, func(i, j int) bool { return report.Visible[i].Email < report.Visible[j].Email })
	sort.Slice(report.NotVisible, func(i, j int) bool { return report.NotVisible[i].Email < report.NotVisible[j].Email })
	sort.Slice(report.Undetermined, func(i, j int) bool { return report.Undetermined[i].Email < report.Undetermined[j].Email })
	sort.Slice(report.UnresolvedGroups, func(i, j int) bool {
		return report.UnresolvedGroups[i].Group < report.UnresolvedGroups[j].Group
	})
}

func writeVisibilityReport(output io.Writer, outputFormat string, report visibilityReport, selectedStatuses map[string]bool) error {
	if outputFormat == "json" {
		filtered := emptyVisibilityReport()
		if selectedStatuses["visible"] {
			filtered.Visible = report.Visible
		}
		if selectedStatuses["not_visible"] {
			filtered.NotVisible = report.NotVisible
		}
		if selectedStatuses["undetermined"] {
			filtered.Undetermined = report.Undetermined
		}
		if selectedStatuses["unresolved_groups"] {
			filtered.UnresolvedGroups = report.UnresolvedGroups
		}
		filtered.Counts = visibilityCounts{
			Visible:          len(filtered.Visible),
			NotVisible:       len(filtered.NotVisible),
			Undetermined:     len(filtered.Undetermined),
			UnresolvedGroups: len(filtered.UnresolvedGroups),
		}
		if err := json.NewEncoder(output).Encode(filtered); err != nil {
			return fmt.Errorf("unable to encode visibility report: %w", err)
		}
		return nil
	}
	for _, section := range []struct {
		status  string
		title   string
		results []visibilityResult
	}{
		{"visible", "Visible", report.Visible},
		{"not_visible", "Not visible", report.NotVisible},
		{"undetermined", "Undetermined", report.Undetermined},
	} {
		if !selectedStatuses[section.status] {
			continue
		}
		if _, err := fmt.Fprintf(output, "%s (%d):\n", section.title, len(section.results)); err != nil {
			return err
		}
		for _, result := range section.results {
			detail := result.AccessRole
			if result.Reason != "" {
				if detail != "" {
					detail += ": "
				}
				detail += result.Reason
			}
			if _, err := fmt.Fprintf(output, "  %s", result.Email); err != nil {
				return err
			}
			if detail != "" {
				if _, err := fmt.Fprintf(output, " (%s)", detail); err != nil {
					return err
				}
			}
			if _, err := fmt.Fprintln(output); err != nil {
				return err
			}
		}
	}
	if selectedStatuses["unresolved_groups"] {
		if _, err := fmt.Fprintf(output, "Unresolved groups (%d):\n", len(report.UnresolvedGroups)); err != nil {
			return err
		}
		for _, group := range report.UnresolvedGroups {
			if _, err := fmt.Fprintf(output, "  %s (%s)\n", group.Group, group.Reason); err != nil {
				return err
			}
		}
	}
	return nil
}
