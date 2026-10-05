package render

import (
	"strings"
	"testing"
	"time"

	"github.com/srz-zumix/gali/internal/gcalendar"
	admdir "google.golang.org/api/admin/directory/v1"
	"google.golang.org/api/calendar/v3"
)

func TestTableRendering(t *testing.T) {
	longText := strings.Repeat("long description ", 10) + "end"
	tests := []struct {
		name   string
		render func(*Renderer)
		want   []string
	}{
		{
			name: "calendars",
			render: func(renderer *Renderer) {
				renderer.RenderCalendarListDefault(&calendar.CalendarList{
					Items: []*calendar.CalendarListEntry{{Id: "team@example.com", Summary: "Team Calendar"}},
				})
			},
			want: []string{"team@example.com", "Team Calendar"},
		},
		{
			name: "events",
			render: func(renderer *Renderer) {
				renderer.RenderEvents(&calendar.Events{
					Items: []*calendar.Event{{Summary: longText + "\nsecond line"}},
				}, []string{"SUMMARY"})
			},
			want: []string{longText, "second line"},
		},
		{
			name: "resources",
			render: func(renderer *Renderer) {
				renderer.RenderCalendarResource([]*admdir.CalendarResource{
					{ResourceName: "Room One", ResourceEmail: "room1@example.com", UserVisibleDescription: longText + "\nsecond line"},
					{ResourceName: "Room Two", ResourceEmail: "room2@example.com"},
				})
			},
			want: []string{"Room One", "Room Two", "room1@example.com", "room2@example.com", longText, "second line"},
		},
		{
			name: "candidates",
			render: func(renderer *Renderer) {
				start := time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)
				renderer.RenderCandidates([]gcalendar.SlotCandidate{
					{
						Start: start,
						End:   start.Add(time.Hour),
						Conflicts: []gcalendar.SlotConflict{
							{CalendarID: "team@example.com", Event: &calendar.Event{Summary: longText}},
						},
					},
				})
			},
			want: []string{"2026-10-05 09:00-10:00", "[team@example.com] " + longText},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			renderer := NewStringRenderer()
			test.render(&renderer.Renderer)
			output := renderer.Stdout.String()
			for _, want := range test.want {
				if !strings.Contains(output, want) {
					t.Errorf("table output missing %q:\n%s", want, output)
				}
			}
		})
	}
}

func TestCalendarResourceRowSeparators(t *testing.T) {
	renderer := NewStringRenderer()
	renderer.Renderer.RenderCalendarResource([]*admdir.CalendarResource{
		{ResourceName: "Room One"},
		{ResourceName: "Room Two"},
	})
	output := renderer.Stdout.String()
	betweenRows := false
	separatorFound := false
	previousLine := ""
	headerSeparator := ""
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "Room One") {
			betweenRows = true
			headerSeparator = previousLine
		} else if strings.Contains(line, "Room Two") {
			break
		} else if betweenRows && line == headerSeparator && strings.TrimSpace(line) != "" {
			separatorFound = true
		}
		previousLine = line
	}
	if !separatorFound {
		t.Fatalf("missing separator between resource rows:\n%s", output)
	}
}
