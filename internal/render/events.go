package render

import (
	"strings"

	"google.golang.org/api/calendar/v3"
)

type EventFieldGetter func(e *calendar.Event) string
type EventFieldGetters struct {
	Func map[string]EventFieldGetter
}

func NewEventFieldGetters() *EventFieldGetters {
	return &EventFieldGetters{
		Func: map[string]EventFieldGetter{
			"START": func(e *calendar.Event) string {
				if e.Start.DateTime != "" {
					return e.Start.DateTime
				}
				return e.Start.Date
			},
			"END": func(e *calendar.Event) string {
				if e.End.DateTime != "" {
					return e.End.DateTime
				}
				return e.End.Date
			},
			"DATE": func(e *calendar.Event) string {
				if e.Start.DateTime != "" {
					return e.Start.DateTime[:10] // YYYY-MM-DD
				}
				return e.Start.Date
			},
			"SUMMARY": func(e *calendar.Event) string {
				if e.Summary == "" {
					return "Private Event"
				}
				return e.Summary
			},
			"DESCRIPTION": func(e *calendar.Event) string { return e.Description },
			"LOCATION":    func(e *calendar.Event) string { return e.Location },
		},
	}
}

func (g *EventFieldGetters) GetField(e *calendar.Event, field string) string {
	field = strings.ToUpper(field)
	if getter, ok := g.Func[field]; ok {
		return getter(e)
	}
	return ""
}

func (r *Renderer) RenderEvents(events *calendar.Events, headers []string) {
	if r.exporter != nil {
		r.exporter.Export(events)
		return
	}
	getter := NewEventFieldGetters()
	table := r.newTableWriter(headers)
	for _, event := range events.Items {
		row := make([]string, len(headers))
		for i, header := range headers {
			row[i] = getter.GetField(event, header)
		}
		table.Append(row)
	}
	table.Render()
}

// 既存のRenderEventsはデフォルトヘッダーで呼び出す
func (r *Renderer) RenderEventsDefault(events *calendar.Events) {
	r.RenderEvents(events, []string{"Start", "End", "Summary"})
}
