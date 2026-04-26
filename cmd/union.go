package cmd

import (
	"fmt"
	"log"
	"maps"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"github.com/srz-zumix/gali/internal/render"
	"github.com/srz-zumix/gali/internal/tui"
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
	f.BoolVarP(&useTUI, "tui", "t", false, "Show events in TUI mode")
	AddDebugFlag(cmd)
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

	var union = &calendar.Events{Items: []*calendar.Event{}}
	var unionMap = map[string]*calendar.Event{}

	for idx, cal := range calendars {
		for id, ev := range cal {
			name := calendarIDs[idx]
			attendees := gcalendar.FindAttendeeByEmail(ev, name)
			if attendees != nil {
				ev.Attendees = []*calendar.EventAttendee{attendees}
			} else {
				ev.Attendees = []*calendar.EventAttendee{
					{Email: name, DisplayName: name},
				}
			}
			if cur, ok := unionMap[id]; ok {
				cur.Attendees = append(cur.Attendees, ev.Attendees...)
			} else {
				unionMap[id] = ev
			}
		}
	}

	union.Items = slices.Collect(maps.Values(unionMap))

	// Sort events by start time
	sort.Slice(union.Items, func(i, j int) bool {
		startI := union.Items[i].Start.DateTime
		if startI == "" {
			startI = union.Items[i].Start.Date
		}
		startJ := union.Items[j].Start.DateTime
		if startJ == "" {
			startJ = union.Items[j].Start.Date
		}
		return startI < startJ
	})

	refEventMap, err := gcalendar.GetReferenceMappedEvents(srv, since, until, refIDs, refMyCals, building)
	if err != nil {
		log.Fatalf("Unable to retrieve events from ref calendars: %v", err)
	}

	gcalendar.CompletePrivateEvents(union, refEventMap)

	if useTUI {
		loc := loadLocation()
		title := fmt.Sprintf("gali union (%s)", strings.Join(calendarIDs, ", "))
		fetchEvents := func(since, until string) (*calendar.Events, error) {
			cals := gcalendar.GetIdMappedEvents(srv, since, until, calendarIDs...)
			var result = &calendar.Events{Items: []*calendar.Event{}}
			var uMap = map[string]*calendar.Event{}
			for idx, cal := range cals {
				for id, ev := range cal {
					name := calendarIDs[idx]
					attendees := gcalendar.FindAttendeeByEmail(ev, name)
					if attendees != nil {
						ev.Attendees = []*calendar.EventAttendee{attendees}
					} else {
						ev.Attendees = []*calendar.EventAttendee{
							{Email: name, DisplayName: name},
						}
					}
					if cur, ok := uMap[id]; ok {
						cur.Attendees = append(cur.Attendees, ev.Attendees...)
					} else {
						uMap[id] = ev
					}
				}
			}
			result.Items = slices.Collect(maps.Values(uMap))
			sort.Slice(result.Items, func(i, j int) bool {
				startI := result.Items[i].Start.DateTime
				if startI == "" {
					startI = result.Items[i].Start.Date
				}
				startJ := result.Items[j].Start.DateTime
				if startJ == "" {
					startJ = result.Items[j].Start.Date
				}
				return startI < startJ
			})
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
		err = tui.RunMonthView(union, tui.MonthViewOptions{
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
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderEventsWithAttendees(union)
}
