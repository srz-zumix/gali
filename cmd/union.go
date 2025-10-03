package cmd

import (
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"github.com/srz-zumix/gali/internal/render"
	"google.golang.org/api/calendar/v3"
)

func NewUnionCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "union <calendarId1> <calendarId2>",
		Short:   "Show events with the same ID in two calendars",
		Aliases: []string{"u"},
		Args:    cobra.MinimumNArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			unionEvents(args...)
		},
	}
	f := cmd.Flags()
	f.StringVar(&since, "since", "", "Start date (RFC3339 or YYYY-MM-DD)")
	f.StringVar(&until, "until", "", "End date (RFC3339 or YYYY-MM-DD)")
	f.StringVar(&format, "format", "", "Output format (json or empty for text)")
	f.StringArrayVarP(&refIDs, "ref", "r", nil, "Reference calendar ID(s) for private event completion (can be specified multiple times)")
	f.StringVar(&building, "building", "", "Building ID to fetch all resource emails as reference calendars")
	f.BoolVarP(&refMyCals, "ref-mycals", "R", false, "Use all my calendars as reference for private event completion")
	return cmd
}

func unionEvents(calendarIDs ...string) {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	since, until, err = parser.ParseSinceUntil(since, until)
	if err != nil {
		log.Fatalf("Invalid date format: %v", err)
	}

	calendars := gcalendar.GetIdMappedEvents(srv, since, until, calendarIDs...)

	var union *calendar.Events = &calendar.Events{Items: []*calendar.Event{}}
	var unionMap = map[string]any{}

	for _, cal := range calendars {
		for id, ev := range cal {
			if _, ok := unionMap[id]; !ok {
				union.Items = append(union.Items, ev)
				unionMap[id] = nil
			}
		}
	}

	refEventMap, err := gcalendar.GetReferenceMappedEvents(srv, since, until, refIDs, refMyCals, building)
	if err != nil {
		log.Fatalf("Unable to retrieve events from ref calendars: %v", err)
	}

	gcalendar.CompletePrivateEvents(union, refEventMap)

	renderer := render.NewRenderer()
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderEventsDefault(union)
}
