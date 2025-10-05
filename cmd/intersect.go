package cmd

import (
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"github.com/srz-zumix/gali/internal/render"
	"google.golang.org/api/calendar/v3"
)

func NewIntersectCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "intersect <calendarId1> <calendarId2>",
		Short:   "Show events with the same ID in two calendars",
		Aliases: []string{"i"},
		Args:    cobra.MinimumNArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			intersectEvents(args...)
		},
	}
	f := cmd.Flags()
	f.StringVar(&since, "since", "", "Start date (RFC3339 or YYYY-MM-DD)")
	f.StringVar(&until, "until", "", "End date (RFC3339 or YYYY-MM-DD)")
	f.StringVar(&format, "format", "", "Output format (json or empty for text)")
	f.StringArrayVarP(&refIDs, "ref", "r", nil, "Reference calendar ID(s) for private event completion (can be specified multiple times)")
	f.StringVar(&building, "building", "", "Building ID to fetch all resource emails as reference calendars")
	f.BoolVarP(&refMyCals, "ref-mycals", "R", false, "Use all my calendars as reference for private event completion")
	f.BoolVar(&debug, "debug", false, "Enable debug mode")
	cmd.Flags().MarkHidden("debug")
	return cmd
}

func intersectEvents(calendarIDs ...string) {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	since, until, err = parser.ParseSinceUntil(since, until)
	if err != nil {
		log.Fatalf("Invalid date format: %v", err)
	}

	calendars := gcalendar.GetIdMappedEvents(srv, since, until, calendarIDs...)

	var intersect *calendar.Events = &calendar.Events{Items: []*calendar.Event{}}
	for id, ev := range calendars[0] {
		for _, cal := range calendars[1:] {
			if _, ok := cal[id]; !ok {
				goto NEXT
			}
		}
		intersect.Items = append(intersect.Items, ev)
	NEXT:
	}

	refEventMap, err := gcalendar.GetReferenceMappedEvents(srv, since, until, refIDs, refMyCals, building)
	if err != nil {
		log.Fatalf("Unable to retrieve events from ref calendars: %v", err)
	}

	gcalendar.CompletePrivateEvents(intersect, refEventMap)

	renderer := render.NewRenderer()
	renderer.Debug = debug
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderEventsDefault(intersect)
}
