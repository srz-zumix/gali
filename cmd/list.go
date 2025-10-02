package cmd

import (
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/render"
)

func NewListCmd() *cobra.Command {
	var format string
	cmd := &cobra.Command{
		Use:     "list",
		Short:   "List all calendars (calendarList)",
		Aliases: []string{"ls"},
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
	cl, err := gcalendar.ListCalendarList(srv)
	if err != nil {
		log.Fatalf("Unable to retrieve calendar list: %v", err)
	}
	renderer := render.NewRenderer()
	renderer.SetExporter(render.GetExporter(format))
	renderer.RenderCalendarListDefault(cl)
}
