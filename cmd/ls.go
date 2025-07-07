package cmd

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
)

func NewLsCmd() *cobra.Command {
	var format string
	cmd := &cobra.Command{
		Use:   "ls",
		Short: "List all calendars (calendarList)",
		Run: func(cmd *cobra.Command, args []string) {
			listCalendars(format)
		},
	}
	cmd.Flags().StringVar(&format, "format", "", "Output format (json or empty for text)")
	return cmd
}

func listCalendars(format string) {
	srv, err := gcalendar.GetCalendarService()
	if err != nil {
		log.Fatalf("Unable to retrieve Calendar client: %v", err)
	}
	cl, err := srv.CalendarList.List().Do()
	if err != nil {
		log.Fatalf("Unable to retrieve calendar list: %v", err)
	}
	if format == "json" {
		b, err := json.MarshalIndent(cl, "", "  ")
		if err != nil {
			log.Fatalf("Failed to marshal calendar list to JSON: %v", err)
		}
		fmt.Println(string(b))
		return
	}
	fmt.Println("Calendar List:")
	for _, entry := range cl.Items {
		fmt.Printf("%v: %v\n", entry.Id, entry.Summary)
	}
}
