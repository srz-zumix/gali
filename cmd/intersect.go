package cmd

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"github.com/srz-zumix/gali/internal/render"
	"github.com/srz-zumix/gali/internal/tui"
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
	f.StringVar(&since, "since", "", "Start date (YYYY-MM-DD)")
	f.StringVar(&until, "until", "", "End date (YYYY-MM-DD)")
	f.StringVar(&format, "format", "", "Output format (json or empty for text)")
	f.StringArrayVarP(&refIDs, "ref", "r", nil, "Reference calendar ID(s) for private event completion (can be specified multiple times)")
	f.StringVar(&building, "building", "", "Building ID to fetch all resource emails as reference calendars")
	f.BoolVarP(&refMyCals, "ref-mycals", "R", false, "Use all my calendars as reference for private event completion")
	f.BoolVarP(&showDeclined, "show-declined", "D", false, "Show declined events (yes or no)")
	f.BoolVarP(&useTUI, "tui", "t", false, "Show events in TUI mode")
	AddDebugFlag(cmd)
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

	calendars := gcalendar.GetIdMappedEvents(srv, since, until, showDeclined, calendarIDs...)

	var intersect = &calendar.Events{Items: []*calendar.Event{}}
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

	if useTUI {
		loc := loadLocation()
		title := fmt.Sprintf("gali intersect (%s)", strings.Join(calendarIDs, ", "))
		fetchEvents := func(since, until string) (*calendar.Events, error) {
			cals := gcalendar.GetIdMappedEvents(srv, since, until, showDeclined, calendarIDs...)
			var result = &calendar.Events{Items: []*calendar.Event{}}
			for id, ev := range cals[0] {
				for _, cal := range cals[1:] {
					if _, ok := cal[id]; !ok {
						goto SKIP
					}
				}
				result.Items = append(result.Items, ev)
			SKIP:
			}
			refMap, err := gcalendar.GetReferenceMappedEvents(srv, since, until, refIDs, refMyCals, building)
			if err != nil {
				return nil, err
			}
			gcalendar.CompletePrivateEvents(result, refMap)
			return result, nil
		}
		month := time.Now().In(loc)
		if since != "" {
			if t, err := time.Parse(time.RFC3339, since); err == nil {
				month = t.In(loc)
			}
		}
		err = tui.RunMonthView(intersect, tui.MonthViewOptions{
			Title:        title,
			Month:        month,
			ShowDeclined: showDeclined,
			CalendarIDs:  calendarIDs,
			FetchEvents:  fetchEvents,
		})
		if err != nil {
			log.Fatalf("TUI error: %v", err)
		}
		return
	}

	renderer := render.NewRenderer()
	renderer.Debug = debug
	renderer.ShowDeclined = showDeclined
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderEventsDefault(intersect)
}
