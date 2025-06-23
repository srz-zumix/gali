package cmd

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
)

var (
	calendarID string
	since      string
	until      string
	format     string
)

func NewListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list [calendarId]",
		Short: "List upcoming events",
		Args:  cobra.MaximumNArgs(1),
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
	return cmd
}

func listEvents() {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	call := srv.Events.List(calendarID).ShowDeleted(false).SingleEvents(true).OrderBy("startTime").MaxResults(100)

	today := time.Now().Format("2006-01-02")

	if since == "" {
		since = today
	}
	if until == "" {
		until = today
	}

	if t, err := parseDate(since); err == nil {
		call = call.TimeMin(t.Format(time.RFC3339))
	}
	if t, err := parseDate(until); err == nil {
		// untilは23:59:59にする
		untilTime := t.Add(23*time.Hour + 59*time.Minute + 59*time.Second)
		call = call.TimeMax(untilTime.Format(time.RFC3339))
	}

	events, err := call.Do()
	if err != nil {
		log.Fatalf("Unable to retrieve events: %v", err)
	}

	if format == "json" {
		outputJSON(events)
		return
	}

	fmt.Println("Events:")
	if len(events.Items) == 0 {
		fmt.Println("No events found.")
	} else {
		for _, item := range events.Items {
			date := item.Start.DateTime
			if date == "" {
				date = item.Start.Date
			}
			fmt.Printf("%v: %v (%v)(%v)\n", item.Id, item.Summary, date, item.Status)
		}
	}
}

func outputJSON(events interface{}) {
	b, err := json.MarshalIndent(events, "", "  ")
	if err != nil {
		log.Fatalf("Failed to marshal events to JSON: %v", err)
	}
	fmt.Println(string(b))
}

func parseDate(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	return time.Parse("2006-01-02", s)
}
