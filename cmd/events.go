package cmd

import (
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"github.com/srz-zumix/gali/internal/render"
	"google.golang.org/api/calendar/v3"
)

var (
	calendarID string
	since      string
	until      string
	format     string
	refIDs     []string
	building   string // Add building option
	refMyCals  bool   // Add ref-mycals option
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
	cmd.Flags().StringVar(&since, "since", "", "Start date (RFC3339 or YYYY-MM-DD)")
	cmd.Flags().StringVar(&until, "until", "", "End date (RFC3339 or YYYY-MM-DD)")
	cmd.Flags().StringVar(&format, "format", "", "Output format (json or empty for text)")
	cmd.Flags().StringArrayVarP(&refIDs, "ref", "r", nil, "Reference calendar ID(s) for private event completion (can be specified multiple times)")
	cmd.Flags().StringVar(&building, "building", "", "Building ID to fetch all resource emails as reference calendars")          // Add flag
	cmd.Flags().BoolVarP(&refMyCals, "ref-mycals", "R", false, "Use all my calendars as reference for private event completion") // Add ref-mycals option
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

	if calendarID != "primary" {
		refIDs = append(refIDs, "primary")
	}

	// If ref-mycals is specified, add all my calendars to refIDs
	if refMyCals {
		myCalendarIDs, err := gcalendar.ListCalendarListId(srv)
		if err != nil {
			log.Fatalf("Unable to retrieve my calendar list: %v", err)
		}
		refIDs = append(refIDs, myCalendarIDs...)
	}

	// If building is specified, fetch resource emails and use as refIDs
	if building != "" {
		dsrv, err := gcalendar.GetAdminDirectoryService()
		if err != nil {
			log.Fatalf("Unable to retrieve Admin Directory client: %v", err)
		}
		resources, err := gcalendar.ListAllCalendarResources(dsrv, "my_customer")
		if err != nil {
			log.Fatalf("Unable to list calendar resources: %v", err)
		}
		filtered := gcalendar.FilterCalendarResourcesByBuildingId(resources, building)
		for _, r := range filtered {
			if r.ResourceEmail != "" {
				refIDs = append(refIDs, r.ResourceEmail)
			}
		}
	}

	mainEvents, err := gcalendar.ListEvents(srv, calendarID, since, until)
	if err != nil {
		log.Fatalf("Unable to retrieve events: %v", err)
	}

	refEventMap := map[string]*calendar.Event{}
	if len(refIDs) > 0 {
		refEventMap, err = gcalendar.GetRefEventMap(srv, refIDs, since, until)
		if err != nil {
			log.Fatalf("Unable to retrieve events from ref calendars: %v", err)
		}
	}

	gcalendar.CompletePrivateEvents(mainEvents, refEventMap)
	renderer := render.NewRenderer()
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderEventsDefault(mainEvents)
}
