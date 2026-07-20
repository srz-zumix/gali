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

func NewSuggestCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "suggest <calendarId1> [calendarId2...]",
		Short:   "Suggest candidate meeting slots across multiple calendars",
		Aliases: []string{"s"},
		Args:    cobra.MinimumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			suggestCandidates(args...)
		},
	}
	f := cmd.Flags()
	f.StringVar(&since, "since", "", "Start date (RFC3339 or YYYY-MM-DD). Default: today")
	f.StringVar(&until, "until", "", "End date (RFC3339 or YYYY-MM-DD). Default: today+7 days")
	f.StringVar(&format, "format", "", "Output format (json or empty for text)")
	f.StringVar(&duration, "duration", "30m", "Required contiguous free duration (e.g. 30m, 1h)")
	f.StringVar(&step, "step", "30m", "Slot search step (e.g. 15m, 30m)")
	f.StringVar(&workHours, "work-hours", "10:00-18:00", "Work hours window (HH:MM-HH:MM)")
	f.BoolVar(&includeWeekends, "include-weekends", false, "Include Saturday/Sunday slots")
	f.IntVar(&maxCandidates, "max-candidates", 0, "Maximum number of candidates to show (0 = unlimited)")
	f.StringArrayVarP(&refIDs, "ref", "r", nil, "Reference calendar ID(s) for private event completion (can be specified multiple times)")
	f.StringVar(&building, "building", "", "Building ID to fetch all resource emails as reference calendars")
	f.BoolVarP(&refMyCals, "ref-mycals", "R", false, "Use all my calendars as reference for private event completion")
	f.BoolVarP(&useTUI, "tui", "t", false, "Show candidates in TUI mode")
	AddDebugFlag(cmd)
	return cmd
}

func suggestCandidates(calendarIDs ...string) {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	if since == "" && until == "" {
		since = time.Now().Format("2006-01-02")
		until = time.Now().AddDate(0, 0, 7).Format("2006-01-02")
	}
	since, until, err = parser.ParseSinceUntil(since, until)
	if err != nil {
		log.Fatalf("Invalid date format: %v", err)
	}

	durationDur, err := time.ParseDuration(duration)
	if err != nil {
		log.Fatalf("Invalid --duration: %v", err)
	}
	stepDur, err := time.ParseDuration(step)
	if err != nil {
		log.Fatalf("Invalid --step: %v", err)
	}
	workStart, workEnd, err := parser.ParseWorkHours(workHours)
	if err != nil {
		log.Fatalf("Invalid --work-hours: %v", err)
	}

	loc := loadLocation()

	fetchCandidates := func(since, until string) ([]gcalendar.SlotCandidate, error) {
		sinceTime, err := time.Parse(time.RFC3339, since)
		if err != nil {
			return nil, err
		}
		untilTime, err := time.Parse(time.RFC3339, until)
		if err != nil {
			return nil, err
		}
		eventsByCalendar := make([][]*calendar.Event, len(calendarIDs))
		refEventMap, err := gcalendar.GetReferenceMappedEvents(srv, since, until, refIDs, refMyCals, building)
		if err != nil {
			return nil, err
		}
		for i, calID := range calendarIDs {
			events, err := gcalendar.ListEvents(srv, calID, since, until)
			if err != nil {
				return nil, fmt.Errorf("unable to retrieve events for %s: %w", calID, err)
			}
			gcalendar.CompletePrivateEvents(events, refEventMap)
			eventsByCalendar[i] = events.Items
			if debug {
				busyCnt, adjCnt, ignCnt := 0, 0, 0
				for _, e := range events.Items {
					switch {
					case gcalendar.IsIgnorableEvent(e):
						ignCnt++
					case gcalendar.IsAdjustableEvent(e):
						adjCnt++
					default:
						busyCnt++
						start := ""
						if e.Start != nil {
							start = e.Start.DateTime
							if start == "" {
								start = e.Start.Date
							}
						}
						log.Printf("[debug] busy event: %s %q (%s)", start, e.Summary, calID)
					}
				}
				log.Printf("[debug] calendar %s: %d events (busy=%d adjustable=%d ignored=%d)", calID, len(events.Items), busyCnt, adjCnt, ignCnt)
			}
		}
		opts := gcalendar.SlotOptions{
			Since:           sinceTime.In(loc),
			Until:           untilTime.In(loc),
			Duration:        durationDur,
			Step:            stepDur,
			WorkStart:       workStart,
			WorkEnd:         workEnd,
			IncludeWeekends: includeWeekends,
			Location:        loc,
			MaxCandidates:   maxCandidates,
		}
		candidates := gcalendar.ComputeCandidates(calendarIDs, eventsByCalendar, opts)
		return candidates, nil
	}

	candidates, err := fetchCandidates(since, until)
	if err != nil {
		log.Fatalf("Unable to compute candidates: %v", err)
	}

	if useTUI {
		title := fmt.Sprintf("gali suggest (%s)", strings.Join(calendarIDs, ", "))
		events := candidatesToEvents(candidates)
		fetchEvents := func(since, until string) (*calendar.Events, error) {
			cands, err := fetchCandidates(since, until)
			if err != nil {
				return nil, err
			}
			return candidatesToEvents(cands), nil
		}
		month := time.Now().In(loc)
		if since != "" {
			if t, err := time.Parse(time.RFC3339, since); err == nil {
				month = t.In(loc)
			}
		}
		err = tui.RunMonthView(events, tui.MonthViewOptions{
			Title:       title,
			Month:       month,
			CalendarIDs: calendarIDs,
			FetchEvents: fetchEvents,
		})
		if err != nil {
			log.Fatalf("TUI error: %v", err)
		}
		return
	}

	renderer := render.NewRenderer()
	renderer.Debug = debug
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderCandidates(candidates)
}

// candidatesToEvents converts candidate slots into synthetic calendar events for TUI display.
func candidatesToEvents(candidates []gcalendar.SlotCandidate) *calendar.Events {
	events := &calendar.Events{Items: []*calendar.Event{}}
	for _, c := range candidates {
		summary := "[FREE]"
		if c.Status == gcalendar.SlotAdjustable {
			names := make([]string, len(c.Conflicts))
			for i, cf := range c.Conflicts {
				name := cf.Event.Summary
				if name == "" {
					name = "Private Event"
				}
				names[i] = name
			}
			summary = fmt.Sprintf("[ADJUSTABLE] %s", strings.Join(names, ", "))
		}
		events.Items = append(events.Items, &calendar.Event{
			Id:      fmt.Sprintf("candidate-%d", c.Start.Unix()),
			Summary: summary,
			Start:   &calendar.EventDateTime{DateTime: c.Start.Format(time.RFC3339)},
			End:     &calendar.EventDateTime{DateTime: c.End.Format(time.RFC3339)},
		})
	}
	return events
}
