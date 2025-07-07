package cmd

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/parser"
	"google.golang.org/api/calendar/v3"
)

func NewIntersectCmd() *cobra.Command {
	var since, until, format string
	cmd := &cobra.Command{
		Use:   "intersect <calendarId1> <calendarId2>",
		Short: "Show events with the same ID in two calendars",
		Args:  cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			calendarID1 := args[0]
			calendarID2 := args[1]
			intersectEvents(calendarID1, calendarID2, since, until, format)
		},
	}
	cmd.Flags().StringVar(&since, "since", "", "Start date (RFC3339 or YYYY-MM-DD)")
	cmd.Flags().StringVar(&until, "until", "", "End date (RFC3339 or YYYY-MM-DD)")
	cmd.Flags().StringVar(&format, "format", "", "Output format (json or empty for text)")
	return cmd
}

func intersectEvents(calendarID1, calendarID2, since, until, format string) {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}

	since, until, err = parser.ParseSinceUntil(since, until)
	if err != nil {
		log.Fatalf("Invalid date format: %v", err)
	}

	getEvents := func(calID string) map[string]*calendar.Event {
		events, err := gcalendar.ListEvents(srv, calID, since, until)
		if err != nil {
			log.Fatalf("Unable to retrieve events for %s: %v", calID, err)
		}
		m := make(map[string]*calendar.Event)
		for _, item := range events.Items {
			m[item.Id] = item
		}
		return m
	}

	e1 := getEvents(calendarID1)
	e2 := getEvents(calendarID2)

	var intersect []*calendar.Event
	for id, ev := range e1 {
		if _, ok := e2[id]; ok {
			intersect = append(intersect, ev)
		}
	}

	if format == "json" {
		b, err := json.MarshalIndent(intersect, "", "  ")
		if err != nil {
			log.Fatalf("Failed to marshal events to JSON: %v", err)
		}
		fmt.Println(string(b))
		return
	}

	fmt.Println("Intersected Events:")
	if len(intersect) == 0 {
		fmt.Println("No intersected events found.")
	} else {
		for _, e := range intersect {
			date := e.Start.DateTime
			if date == "" {
				date = e.Start.Date
			}
			fmt.Printf("%v: %v (%v)(%v)\n", e.Id, e.Summary, date, e.Status)
		}
	}
}
