package res

import (
	"log"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gali/internal/gcalendar"
	"github.com/srz-zumix/gali/internal/render"
)

func NewResListCmd() *cobra.Command {
	var format string
	var buildingId string
	cmd := &cobra.Command{
		Use:     "list",
		Short:   "List resources.calendars.list (Google Workspace Resource Calendars)",
		Aliases: []string{"ls"},
		Run: func(cmd *cobra.Command, args []string) {
			dsrv, err := gcalendar.GetAdminDirectoryService()
			if err != nil {
				log.Fatalf("Unable to create Directory service: %v", err)
			}
			allItems, err := gcalendar.ListAllCalendarResources(dsrv, "my_customer")
			if err != nil {
				log.Fatalf("Unable to retrieve resource calendars: %v", err)
			}
			items := gcalendar.FilterCalendarResourcesByBuildingId(allItems, buildingId)
			renderer := render.NewRenderer()
			renderer.SetExporter(render.GetExporter(format))
			renderer.RenderCalendarResource(items)
		},
	}
	cmd.Flags().StringVar(&format, "format", "", "Output format (json or empty for text)")
	cmd.Flags().StringVar(&buildingId, "building", "", "Filter by buildingId")
	return cmd
}
