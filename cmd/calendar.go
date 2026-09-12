package cmd

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/tui"
	"google.golang.org/api/calendar/v3"
)

func NewCalendarCmd() *cobra.Command {
	var month string
	var showDeclined bool

	cmd := &cobra.Command{
		Use:     "calendar [calendarId]",
		Aliases: []string{"cal"},
		Short:   "Show a monthly calendar in TUI",
		Args:    cobra.MaximumNArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			calendarID := "primary"
			if len(args) > 0 {
				calendarID = args[0]
			}
			runCalendarTUI(calendarID, month, showDeclined)
		},
	}
	f := cmd.Flags()
	f.StringVar(&month, "month", "", "Month to show (YYYY-MM). Default: current month")
	f.BoolVarP(&showDeclined, "show-declined", "D", false, "Show declined events")
	return cmd
}

func runCalendarTUI(calendarID, month string, showDeclined bool) {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	loc := loadLocation()
	base := time.Now().In(loc)
	if month != "" {
		m, err := time.ParseInLocation("2006-01", month, loc)
		if err != nil {
			log.Fatalf("Invalid month format (expected YYYY-MM): %v", err)
		}
		base = m
	}

	monthFirst := time.Date(base.Year(), base.Month(), 1, 0, 0, 0, 0, loc)

	since := monthFirst.Format(time.RFC3339)
	// timeMax is exclusive: use the next month's midnight (DST-safe).
	until := monthFirst.AddDate(0, 1, 0).Format(time.RFC3339)

	events, err := gcalendar.ListEvents(srv, calendarID, since, until)
	if err != nil {
		log.Fatalf("Unable to retrieve events: %v", err)
	}

	title := fmt.Sprintf("gali calendar (%s)", calendarID)
	fetchEvents := func(since, until string) (*calendar.Events, error) {
		return gcalendar.ListEvents(srv, calendarID, since, until)
	}
	err = tui.RunMonthView(events, tui.MonthViewOptions{
		Title:        title,
		Month:        monthFirst,
		ShowDeclined: showDeclined,
		FetchEvents:  fetchEvents,
	})
	if err != nil {
		log.Fatalf("TUI error: %v", err)
	}
}

func loadLocation() *time.Location {
	tz := os.Getenv("TZ")
	if tz == "" {
		tz = "Asia/Tokyo"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.FixedZone("Asia/Tokyo", 9*60*60)
	}
	return loc
}
