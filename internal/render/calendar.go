package render

import (
	"strings"

	"google.golang.org/api/calendar/v3"
)

type CalendarListFieldGetter func(e *calendar.CalendarListEntry) string

type CalendarListFieldGetters struct {
	Func map[string]CalendarListFieldGetter
}

func NewCalendarListFieldGetters() *CalendarListFieldGetters {
	return &CalendarListFieldGetters{
		Func: map[string]CalendarListFieldGetter{
			"ID":          func(e *calendar.CalendarListEntry) string { return e.Id },
			"SUMMARY":     func(e *calendar.CalendarListEntry) string { return e.Summary },
			"DESCRIPTION": func(e *calendar.CalendarListEntry) string { return e.Description },
			"LOCATION":    func(e *calendar.CalendarListEntry) string { return e.Location },
		},
	}
}

func (g *CalendarListFieldGetters) GetField(e *calendar.CalendarListEntry, field string) string {
	field = strings.ToUpper(field)
	if getter, ok := g.Func[field]; ok {
		return getter(e)
	}
	return ""
}

func (r *Renderer) RenderCalendarList(cl *calendar.CalendarList, header []string) {
	if r.exporter != nil {
		r.exporter.Export(cl)
		return
	}
	getter := NewCalendarListFieldGetters()
	table := r.newTableWriter(header)
	for _, entry := range cl.Items {
		row := make([]string, len(header))
		for i, h := range header {
			row[i] = getter.GetField(entry, h)
		}
		table.Append(row)
	}
	table.Render()
}

func (r *Renderer) RenderCalendarListDefault(cl *calendar.CalendarList) {
	r.RenderCalendarList(cl, []string{"Id", "Summary"})
}
