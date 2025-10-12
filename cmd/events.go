package cmd

import (
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"github.com/srz-zumix/gali/internal/render"
)

func NewEventsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "events [calendarId]",
		Aliases: []string{"e"},
		Short:   "List upcoming events",
		Args:    cobra.MaximumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			if len(args) > 0 {
				calendarID = args[0]
			} else {
				calendarID = "primary"
			}
			listEvents()
		},
	}

	f := cmd.Flags()
	f.StringVar(&since, "since", "", "Start date (RFC3339 or YYYY-MM-DD)")
	f.StringVar(&until, "until", "", "End date (RFC3339 or YYYY-MM-DD)")
	f.StringVar(&format, "format", "", "Output format (json or empty for text)")
	f.BoolVarP(&showDeclined, "show-declined", "D", false, "Show declined events (yes or no)")
	f.StringArrayVarP(&refIDs, "ref", "r", nil, "Reference calendar ID(s) for private event completion (can be specified multiple times)")
	f.StringVar(&building, "building", "", "Building ID to fetch all resource emails as reference calendars")
	f.BoolVarP(&refMyCals, "ref-mycals", "R", false, "Use all my calendars as reference for private event completion")
	AddDebugFlag(cmd)
	return cmd
}

func listEvents() {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	since, until, err := parser.ParseSinceUntil(since, until)
	if err != nil {
		log.Fatalf("Invalid date format: %v", err)
	}
	mainEvents, err := gcalendar.ListEvents(srv, calendarID, since, until)
	if err != nil {
		log.Fatalf("Unable to retrieve events: %v", err)
	}

	refEventMap, err := gcalendar.GetReferenceMappedEvents(srv, since, until, refIDs, refMyCals, building)
	if err != nil {
		log.Fatalf("Unable to retrieve events from ref calendars: %v", err)
	}

	gcalendar.CompletePrivateEvents(mainEvents, refEventMap)
	renderer := render.NewRenderer()
	renderer.Debug = debug
	renderer.ShowDeclined = showDeclined
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderEventsDefault(mainEvents)
}
