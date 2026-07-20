package render

import (
	"fmt"
	"strings"
	"time"

	"github.com/srz-zumix/gali/internal/gcalendar"
)

// SlotCandidateJSON is the JSON representation of a gcalendar.SlotCandidate.
type SlotCandidateJSON struct {
	Start     string   `json:"start"`
	End       string   `json:"end"`
	Status    string   `json:"status"`
	Conflicts []string `json:"conflicts,omitempty"`
}

func conflictSummaries(c gcalendar.SlotCandidate) []string {
	summaries := make([]string, len(c.Conflicts))
	for i, cf := range c.Conflicts {
		summary := cf.Event.Summary
		if summary == "" {
			summary = "Private Event"
		}
		summaries[i] = fmt.Sprintf("[%s] %s", cf.CalendarID, summary)
	}
	return summaries
}

// RenderCandidates renders candidate slots as a table or via the configured exporter.
func (r *Renderer) RenderCandidates(candidates []gcalendar.SlotCandidate) {
	if r.exporter != nil {
		out := make([]SlotCandidateJSON, len(candidates))
		for i, c := range candidates {
			out[i] = SlotCandidateJSON{
				Start:     c.Start.Format(time.RFC3339),
				End:       c.End.Format(time.RFC3339),
				Status:    string(c.Status),
				Conflicts: conflictSummaries(c),
			}
		}
		r.exporter.Export(out)
		return
	}

	headers := []string{"DATE_TIME", "STATUS", "CONFLICTS"}
	table := r.newTableWriter(headers)
	table.SetAutoWrapText(false)
	for _, c := range candidates {
		row := []string{
			fmt.Sprintf("%s %s-%s", c.Start.Format("2006-01-02"), c.Start.Format("15:04"), c.End.Format("15:04")),
			string(c.Status),
			strings.Join(conflictSummaries(c), "\n"),
		}
		table.Append(row)
	}
	table.Render()
}
