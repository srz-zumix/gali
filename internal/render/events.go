package render

import (
	"strings"
	"time"

	"google.golang.org/api/calendar/v3"
)

type EventFieldGetter func(e *calendar.Event) string
type EventFieldGetters struct {
	Func map[string]EventFieldGetter
}

func getPeriod(e *calendar.Event) string {
	if e.Start.DateTime == "" {
		return ""
	}
	start := e.Start.DateTime
	end := e.End.DateTime
	// 時刻部分のみ抽出
	parseTime := func(dt string) string {
		t, err := time.Parse(time.RFC3339, dt)
		if err == nil {
			return t.Format("15:04")
		}
		if len(dt) >= 16 && dt[10] == 'T' {
			return dt[11:16]
		}
		return ""
	}
	startHM := parseTime(start)
	endHM := parseTime(end)
	return startHM + "-" + endHM
}

func getDate(e *calendar.Event) string {
	if e.Start.DateTime != "" {
		return e.Start.DateTime[:10] // YYYY-MM-DD
	}
	return e.Start.Date
}

func getDateTime(e *calendar.Event) string {
	period := getPeriod(e)
	date := getDate(e)
	if period == "" {
		return date
	}
	return date + " " + period
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
			"PERIOD": func(e *calendar.Event) string {
				return getPeriod(e)
			},
			"TIME": func(e *calendar.Event) string {
				return getPeriod(e)
			},
			"DATE": func(e *calendar.Event) string {
				return getDate(e)
			},
			"DATE_TIME": func(e *calendar.Event) string {
				return getDateTime(e)
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
	r.RenderEvents(events, []string{"DATE_TIME", "SUMMARY"})
}
