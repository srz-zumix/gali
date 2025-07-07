package render

import (
	"github.com/olekukonko/tablewriter"
	admdir "google.golang.org/api/admin/directory/v1"
)

func (r *Renderer) RenderCalendarResource(resources []*admdir.CalendarResource) {
	if r.exporter != nil {
		r.exporter.Export(resources)
		return
	}

	table := tablewriter.NewWriter(r.IO.Out)
	table.SetHeader([]string{"Name", "Email", "Building ID", "Description"})
	table.SetAutoWrapText(false)
	table.SetRowLine(true)

	for _, resource := range resources {
		row := []string{
			resource.ResourceName,
			resource.ResourceEmail,
			resource.BuildingId,
			resource.UserVisibleDescription,
		}
		table.Append(row)
	}

	table.Render()
}
